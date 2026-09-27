import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  DEFAULT_CONTINUATION_HISTORY_LIMIT,
  limitExecutionContinuationHistory,
  readContinuationHistoryLimit,
} from "./continuation-history-limit.js";

type Message = ExecutionContinuationEnvelope["messages"][number];

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    authorType: "agent",
    authorId: "agent-a",
    createdByRunId: null,
    body: `note ${id}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deleted: false,
    sourceTrust: null,
    ...overrides,
  };
}

function envelope(overrides: Partial<ExecutionContinuationEnvelope> = {}): ExecutionContinuationEnvelope {
  return {
    version: 1,
    companyId: "company-a",
    issueId: "issue-a",
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
    originCommentIds: [],
    objective: "objective",
    messages: [],
    interactionOutcomes: [],
    completedWork: null,
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    ...overrides,
  };
}

const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);

describe("readContinuationHistoryLimit", () => {
  it("defaults to 30", () => {
    expect(DEFAULT_CONTINUATION_HISTORY_LIMIT).toBe(30);
    expect(readContinuationHistoryLimit({})).toBe(30);
  });

  it("reads a non-negative integer and falls back on invalid values", () => {
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "0" })).toBe(0);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: " 12 " })).toBe(12);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "-5" })).toBe(30);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "ten" })).toBe(30);
    expect(readContinuationHistoryLimit({ MYRMIDON_CONTINUATION_HISTORY_LIMIT: "" })).toBe(30);
  });
});

describe("limitExecutionContinuationHistory", () => {
  it("leaves a short history untouched", () => {
    const input = envelope({ messages: [message("m1"), message("m2")] });
    expect(limitExecutionContinuationHistory(input, 5)).toBe(input);
  });

  it("keeps pinned requests and origin comments plus the newest messages", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`m${i}`));
    messages[0] = message("m0", { authorType: "user", authorId: "user-a", body: "first request" });
    messages[7] = message("m7", { authorType: "user", authorId: "user-a", body: "latest request" });
    // A run-authored user comment is not direction and does not count as the latest request.
    messages[15] = message("m15", { authorType: "user", authorId: "user-a", createdByRunId: "run-a" });
    const result = limitExecutionContinuationHistory(envelope({ messages, originCommentIds: ["m3"] }), 6);

    expect(ids(result.messages)).toEqual(["m0", "m3", "m7", "m17", "m18", "m19"]);
    expect(result.historyTruncation?.messages).toEqual({ kept: 6, dropped: 14, total: 20 });
    expect(result.truncationNotice).toContain("messages 14 of 20");
  });

  it("limits the other unbounded lists to their newest entries", () => {
    const list = Array.from({ length: 8 }, (_, i) => i);
    const result = limitExecutionContinuationHistory(
      envelope({
        interactionOutcomes: list.map((i) => ({ id: `i${i}`, kind: "k", status: "accepted", result: null })),
        completedActions: list.map((i) => ({ runId: "r", receiptId: `c${i}`, operationId: "op", result: null })),
        recoveryOutcomes: list.map((i) => ({ recoveryActionId: `a${i}`, decision: null })),
        unresolvedInteractionIds: list.map((i) => `u${i}`),
      }),
      3,
    );
    expect(ids(result.interactionOutcomes)).toEqual(["i5", "i6", "i7"]);
    expect(result.completedActions?.map((entry) => entry.receiptId)).toEqual(["c5", "c6", "c7"]);
    expect(result.recoveryOutcomes?.map((entry) => entry.recoveryActionId)).toEqual(["a5", "a6", "a7"]);
    expect(result.unresolvedInteractionIds).toEqual(["u5", "u6", "u7"]);
    expect(Object.keys(result.historyTruncation ?? {}).sort()).toEqual([
      "completedActions",
      "interactionOutcomes",
      "recoveryOutcomes",
      "unresolvedInteractionIds",
    ]);
  });

  it("limits the resume delta with the same pins", () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(`m${i}`));
    messages[1] = message("m1", { authorType: "user", authorId: "user-a", body: "request" });
    const result = limitExecutionContinuationHistory(
      envelope({ messages, resumeDelta: { baseRunId: "run-a", messages: messages.slice(1) } }),
      3,
    );
    expect(result.resumeDelta?.baseRunId).toBe("run-a");
    expect(ids(result.resumeDelta?.messages ?? [])).toEqual(["m1", "m8", "m9"]);
    expect(result.historyTruncation?.resumeDeltaMessages).toEqual({ kept: 3, dropped: 6, total: 9 });
  });

  it("does nothing when the limit is 0", () => {
    const input = envelope({ messages: Array.from({ length: 50 }, (_, i) => message(`m${i}`)) });
    expect(limitExecutionContinuationHistory(input, 0)).toBe(input);
  });
});
