import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditQueuedComment } from "../modules/wake-queue/application/queued-comment-use-cases.js";
import type {
  LockedQueuedCommentState,
  QueuedCommentActor,
  QueuedCommentIssueContext,
  QueuedCommentIssueLockWriter,
  QueuedCommentQueueSnapshot,
  QueuedCommentQueueTransaction,
} from "../modules/wake-queue/application/queued-comment-ports.js";
import { registerSecretValues, resetSecretMasking } from "./secret-masking.js";

// Obviously fake values: nothing here is a real credential.
const TOOL_TOKEN = "fake-tool-token-value-0001";

const ISSUE: QueuedCommentIssueContext = {
  id: "issue-1",
  companyId: "company-1",
  assigneeAgentId: "agent-1",
  executionRunId: null,
};

const USER_ACTOR: QueuedCommentActor = {
  actorType: "user",
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

function fakeTransaction(
  overrides: Partial<QueuedCommentQueueTransaction> = {},
): QueuedCommentQueueTransaction {
  return {
    updateCommentBody: vi.fn(async () => true),
    touchIssueUpdatedAt: vi.fn(async () => {}),
    updateWakeQueuedCommentIds: vi.fn(async () => ({
      id: "wake-1",
      agentId: "agent-1",
      status: "deferred_issue_execution",
      runId: null,
      payload: {},
    })),
    updateQueueRunCommentIds: vi.fn(async (input: { queueRunId: string }) => ({
      id: input.queueRunId,
      status: "queued",
      runtimeMode: null,
      contextSnapshot: {},
    })),
    deleteComment: vi.fn(async () => null),
    cancelWake: vi.fn(async () => {}),
    cancelQueueRun: vi.fn(async () => ({ id: "run-1" })),
    clearExecutionLockAndTouchIssue: vi.fn(async () => {}),
    buildQueueSnapshot: vi.fn(async () => fakeQueueSnapshot()),
    syncCommentReferences: vi.fn(async () => {}),
    deleteCommentReferenceSource: vi.fn(async () => {}),
    syncCommentExternalObjectsSafely: vi.fn(async () => {}),
    logActivity: vi.fn(async () => ({ companyId: "company-1", payload: {}, pluginEvent: null })),
    ...overrides,
  };
}

function fakeQueueSnapshot(): QueuedCommentQueueSnapshot {
  return {
    issueId: ISSUE.id,
    queueId: "wake-1",
    state: "deferred",
    targetRunId: null,
    revision: "rev-1",
    protocol: "legacy",
    steeringDisposition: "unsupported",
    entries: [
      {
        comment: {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "user",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "queued comment",
          presentation: null,
          metadata: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
        position: 0,
        canEdit: true,
        canDiscard: true,
      },
    ],
  };
}

function fakeLockedState(): LockedQueuedCommentState {
  return {
    wake: { id: "wake-1", agentId: "agent-1", status: "deferred_issue_execution", runId: null, payload: {} },
    state: "deferred",
    queueRun: null,
    activeRun: null,
    queue: fakeQueueSnapshot(),
  };
}

describe("myrmidon(S5) masked fields without a database", () => {
  afterEach(() => resetSecretMasking());

  it("editQueuedComment stores the masked body", async () => {
    resetSecretMasking();
    registerSecretValues({ TOOL_TOKEN: TOOL_TOKEN }, ["TOOL_TOKEN"]);
    const updateCommentBody = vi.fn(async () => true);
    const lock: QueuedCommentIssueLockWriter = {
      withLockedQueue: vi.fn(async (_input, fn) =>
        fn(fakeLockedState(), fakeTransaction({ updateCommentBody })),
      ),
    };
    await createEditQueuedComment({ issueLock: lock })({
      issue: ISSUE,
      actor: USER_ACTOR,
      commentId: "comment-1",
      queueId: "wake-1",
      revision: "rev-1",
      body: `edited: ${TOOL_TOKEN}`,
      now: new Date(),
    });
    const body = updateCommentBody.mock.calls[0]![0]!.body as string;
    expect(body).toBe("edited: [secret:TOOL_TOKEN]");
    expect(body).not.toContain(TOOL_TOKEN);
  });

  it("editQueuedComment keeps ordinary text unchanged", async () => {
    const updateCommentBody = vi.fn(async () => true);
    const lock: QueuedCommentIssueLockWriter = {
      withLockedQueue: vi.fn(async (_input, fn) =>
        fn(fakeLockedState(), fakeTransaction({ updateCommentBody })),
      ),
    };
    await createEditQueuedComment({ issueLock: lock })({
      issue: ISSUE,
      actor: USER_ACTOR,
      commentId: "comment-1",
      queueId: "wake-1",
      revision: "rev-1",
      body: "no secrets here, just an edit",
      now: new Date(),
    });
    expect(updateCommentBody.mock.calls[0]![0]!.body).toBe("no secrets here, just an edit");
  });
});

