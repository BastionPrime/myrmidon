// ui/src/ui2/tests/ui2DecisionsModel.myrmidon.test.ts
//
// myrmidon(UI2): pure-model tests for the Decisions helpers: filter-group
// derivation from ruleKey, option ordering (recommended first), effect
// summaries, age math, and group counting. These pin the CONTRACT between
// the screen and the vendor decision DTO — no server needed.

import { describe, expect, it } from "vitest";
import type { DecisionOption } from "@paperclipai/shared";
import type { Decision } from "@/api/decisions";
import {
  ui2DecisionAge,
  ui2DecisionGroup,
  ui2GroupCounts,
  ui2OptionEffectSummary,
  ui2SortOptions,
} from "../screens/decisions/ui2DecisionsModel";

function option(overrides: Partial<DecisionOption> = {}): DecisionOption {
  return {
    id: "opt-1",
    label: "Option",
    effects: [],
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision-1",
    companyId: "company-1",
    bundleId: null,
    originAgentId: "agent-1",
    originIssueId: "issue-1",
    originRunId: "run-1",
    ruleKey: null,
    title: "Decision",
    body: "Body",
    options: [],
    inputs: null,
    status: "open",
    executionStatus: null,
    chosenOptionId: null,
    inputValues: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: "2026-10-02T12:00:00.000Z",
    idempotencyKey: null,
    targetSnapshots: {},
    continuationPolicy: "none",
    metadata: {},
    createdAt: "2026-10-02T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  } as Decision;
}

describe("myrmidon(UI2) ui2DecisionGroup", () => {
  it("classifies money rule keys", () => {
    expect(ui2DecisionGroup(decision({ ruleKey: "budget_raise" }))).toBe("money");
    expect(ui2DecisionGroup(decision({ ruleKey: "spend_limit" }))).toBe("money");
  });

  it("classifies external rule keys", () => {
    expect(ui2DecisionGroup(decision({ ruleKey: "owner_email_reply" }))).toBe("external");
    expect(ui2DecisionGroup(decision({ ruleKey: "telegram_post" }))).toBe("external");
  });

  it("classifies policy rule keys", () => {
    expect(ui2DecisionGroup(decision({ ruleKey: "permission_grant" }))).toBe("policies");
  });

  it("falls back to the other bucket", () => {
    expect(ui2DecisionGroup(decision({ ruleKey: "unknown_shape" }))).toBe("other");
    expect(ui2DecisionGroup(decision({ ruleKey: null }))).toBe("other");
  });
});

describe("myrmidon(UI2) ui2SortOptions", () => {
  it("puts primary-style options first, then alphabetical", () => {
    const sorted = ui2SortOptions([
      option({ id: "b", label: "Buy" }),
      option({ id: "a", label: "Ask", style: "primary" }),
      option({ id: "c", label: "Cancel" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

describe("myrmidon(UI2) ui2OptionEffectSummary", () => {
  it("summarizes each effect kind in a human phrase", () => {
    expect(
      ui2OptionEffectSummary(
        option({
          effects: [
            {
              type: "comment_on_issue",
              targetIssueId: "i1",
              staleness: "strict",
              bodyMarkdown: "note",
            },
          ],
        }),
      ),
    ).toBe("comment");
    expect(
      ui2OptionEffectSummary(
        option({
          effects: [
            {
              type: "update_issue_status",
              targetIssueId: "i1",
              staleness: "strict",
              status: "in_progress",
            },
          ],
        }),
      ),
    ).toBe("status → in_progress");
  });

  it("dedupes repeated effect phrases", () => {
    const comment = {
      type: "comment_on_issue",
      targetIssueId: "i1",
      staleness: "strict",
      bodyMarkdown: "x",
    } as const;
    expect(ui2OptionEffectSummary(option({ effects: [comment, comment] }))).toBe("comment");
  });

  it("says no effects for an empty list", () => {
    expect(ui2OptionEffectSummary(option())).toBe("no effects");
  });
});

describe("myrmidon(UI2) ui2DecisionAge", () => {
  it("formats minutes, hours and days from createdAt", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    expect(ui2DecisionAge("2026-10-02T11:59:30.000Z", now)).toBe("0m");
    expect(ui2DecisionAge("2026-10-02T11:30:00.000Z", now)).toBe("30m");
    expect(ui2DecisionAge("2026-10-02T09:00:00.000Z", now)).toBe("3h");
    expect(ui2DecisionAge("2026-09-30T12:00:00.000Z", now)).toBe("2d");
  });

  it("never goes negative", () => {
    expect(ui2DecisionAge("2026-10-02T13:00:00.000Z", new Date("2026-10-02T12:00:00.000Z"))).toBe("0m");
  });
});

describe("myrmidon(UI2) ui2GroupCounts", () => {
  it("counts decisions per group", () => {
    const counts = ui2GroupCounts([
      decision({ id: "a", ruleKey: "budget_raise" }),
      decision({ id: "b", ruleKey: "budget_raise" }),
      decision({ id: "c", ruleKey: "telegram_post" }),
      decision({ id: "d", ruleKey: null }),
    ]);
    expect(counts).toEqual({ policies: 0, money: 2, external: 1, other: 1 });
  });
});
