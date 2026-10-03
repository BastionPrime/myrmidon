// server/src/myrmidon/wip-limit/wip-limit.myrmidon.test.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the acceptance tests of the per-agent WIP limit.
//
// The *.myrmidon.test.ts style of this repo: no database, neutral data, the
// decisions pinned at the domain seams (the shared resolver and the module
// functions with fake ports). The five decisions the ticket names:
//
//   1. the limit resolves per-agent over the default, and an explicit null
//      means count-only (no signal, ever, for that agent);
//   2. an agent over its limit raises exactly one status row with
//      overLimit=true and the wip = in_progress + in_review arithmetic;
//   3. the lead rule: an agent with a direct report holding ANY in-flight
//      task is over the limit (the implementation limit of a lead is 0);
//   4. the attention cards exist only for over-limit agents, with the lead
//      wording when the lead rule fired;
//   5. the guard: on the base revision (no generator) the feed contains no
//      `wip_limit` source kind, with the generator it does — pinned by
//      asserting the kind list the feed can emit.
//   6. the signal dedup: one comment per agent per window (the metadata key
//      carries the window), a second pass in the same window writes nothing.

import { describe, expect, it } from "vitest";
import {
  ATTENTION_SOURCE_KINDS,
  buildWipLimitAgentStatus,
  isWipLimitLead,
  normalizeWipLimitSettings,
  resolveWipLimitForAgent,
  wipLimitSignalKey,
  wipLimitSettingsSchema,
  type WipLimitAgentStatus,
  type WipLimitSettings,
} from "@paperclipai/shared";
import { buildWipLimitAttentionCards } from "./attention.js";
import { deliverWipLimitSignal } from "./signal.js";
import { createWipLimitSweeper, wipLimitsAllDisabled } from "./sweep.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const AGENT_LEAD = "33333333-3333-4333-8333-333333333333";

function status(overrides: Partial<WipLimitAgentStatus> = {}): WipLimitAgentStatus {
  return {
    agentId: AGENT_A,
    inProgress: 0,
    inReview: 0,
    wip: 0,
    limit: null,
    overLimit: false,
    leadRule: false,
    ...overrides,
  };
}

describe("myrmidon(1.6.1-WIP-LIMIT-A) limit resolution", () => {
  it("per-agent wins over the default, and null means count-only", () => {
    const settings: WipLimitSettings = {
      defaultLimit: 3,
      perAgent: { [AGENT_A]: 1, [AGENT_B]: null },
    };
    expect(resolveWipLimitForAgent(settings, AGENT_A)).toBe(1);
    expect(resolveWipLimitForAgent(settings, AGENT_B)).toBeNull();
    expect(resolveWipLimitForAgent(settings, AGENT_LEAD)).toBe(3);
  });

  it("absent settings normalize to count-only", () => {
    expect(normalizeWipLimitSettings(undefined)).toEqual({ defaultLimit: null, perAgent: {} });
    expect(normalizeWipLimitSettings({ defaultLimit: 2 })).toEqual({ defaultLimit: 2, perAgent: {} });
    expect(normalizeWipLimitSettings({ defaultLimit: "x" })).toEqual({ defaultLimit: null, perAgent: {} });
  });

  it("the settings schema rejects non-integer and negative limits", () => {
    expect(wipLimitSettingsSchema.safeParse({ defaultLimit: 2.5, perAgent: {} }).success).toBe(false);
    expect(wipLimitSettingsSchema.safeParse({ defaultLimit: -1, perAgent: {} }).success).toBe(false);
    expect(wipLimitSettingsSchema.safeParse({ defaultLimit: null, perAgent: {} }).success).toBe(true);
  });
});

describe("myrmidon(1.6.1-WIP-LIMIT-A) status rows", () => {
  it("wip is in_progress + in_review and overLimit is strict", () => {
    const row = buildWipLimitAgentStatus({
      agentId: AGENT_A,
      inProgress: 2,
      inReview: 1,
      limit: 3,
      isLead: false,
    });
    expect(row.wip).toBe(3);
    expect(row.overLimit).toBe(false);

    const over = buildWipLimitAgentStatus({
      agentId: AGENT_A,
      inProgress: 2,
      inReview: 2,
      limit: 3,
      isLead: false,
    });
    expect(over.wip).toBe(4);
    expect(over.overLimit).toBe(true);
  });

  it("a null limit never signals", () => {
    const row = buildWipLimitAgentStatus({
      agentId: AGENT_A,
      inProgress: 5,
      inReview: 5,
      limit: null,
      isLead: false,
    });
    expect(row.overLimit).toBe(false);
  });

  it("the lead rule: one direct report makes an agent a lead", () => {
    const reportsById = new Map<string, string | null>([
      [AGENT_A, AGENT_LEAD],
      [AGENT_B, null],
      [AGENT_LEAD, null],
    ]);
    expect(isWipLimitLead(AGENT_LEAD, reportsById)).toBe(true);
    expect(isWipLimitLead(AGENT_A, reportsById)).toBe(false);
  });

  it("a lead holding any in-flight task is over the limit (limit 0)", () => {
    const row = buildWipLimitAgentStatus({
      agentId: AGENT_LEAD,
      inProgress: 1,
      inReview: 0,
      limit: 5,
      isLead: true,
    });
    expect(row.overLimit).toBe(true);
    expect(row.leadRule).toBe(true);
    // ... and a lead with no in-flight task is not
    const idle = buildWipLimitAgentStatus({
      agentId: AGENT_LEAD,
      inProgress: 0,
      inReview: 0,
      limit: 5,
      isLead: true,
    });
    expect(idle.overLimit).toBe(false);
  });
});

describe("myrmidon(1.6.1-WIP-LIMIT-A) attention cards", () => {
  it("cards exist only for over-limit agents, with the lead wording", () => {
    const names = new Map([[AGENT_A, "Alpha"], [AGENT_LEAD, "Chief"]] as const);
    const cards = buildWipLimitAttentionCards(
      [
        status({ agentId: AGENT_A, inProgress: 0, inReview: 2, wip: 2, limit: 1, overLimit: true }),
        status({ agentId: AGENT_B, inProgress: 0, inReview: 0, wip: 0, limit: 1, overLimit: false }),
        status({ agentId: AGENT_LEAD, inProgress: 1, wip: 1, limit: 5, overLimit: true, leadRule: true }),
      ],
      names,
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].dedupKey).toBe(`wip_limit:${AGENT_A}`);
    expect(cards[0].title).toBe("Alpha is over its WIP limit");
    expect(cards[0].metadata.originAgentId).toBe(AGENT_A);
    expect(cards[1].title).toBe("Chief is a lead holding implementation work");
    expect(cards[1].leadRule).toBe(true);
  });
});

describe("myrmidon(1.6.1-WIP-LIMIT-A) guard: the feed kind list", () => {
  it("the attention source kind list contains wip_limit (the generator emits it)", () => {
    expect(ATTENTION_SOURCE_KINDS).toContain("wip_limit");
  });

  it("the kind is additive — the base list survives unchanged", () => {
    // The pre-feature kinds, exactly as the base revision had them.
    const baseKinds = [
      "approval",
      "decision",
      "issue_thread_interaction",
      "join_request",
      "recovery_action",
      "productivity_review",
      "blocker_attention",
      "review",
      "failed_run",
      "budget_alert",
      "agent_error_alert",
      "stack_update",
    ];
    for (const kind of baseKinds) {
      expect(ATTENTION_SOURCE_KINDS).toContain(kind);
    }
    expect(ATTENTION_SOURCE_KINDS.filter((kind) => kind === "wip_limit")).toHaveLength(1);
  });
});

describe("myrmidon(1.6.1-WIP-LIMIT-A) signal dedup", () => {
  it("one comment per agent per window; a second call in the window writes nothing", async () => {
    const written: string[] = [];
    const commentsByKey = new Set<string>();
    const windowStart = new Date("2026-10-03T00:00:00Z");
    const ports = {
      addComment: async (_issueId: string, _body: string, _actor: Record<string, never>, options: {
        metadata: { sections: Array<{ rows: Array<{ value: string }> }> };
      }) => {
        const key = options.metadata.sections[0].rows[0].value;
        if (commentsByKey.has(key)) throw new Error("duplicate signal comment");
        commentsByKey.add(key);
        written.push(key);
      },
      now: () => new Date("2026-10-03T12:00:00Z"),
    };
    const db = {
      // hasWipLimitSignalComment: select().from().where().limit();
      // latestInProgressIssue: select().from().where().orderBy().limit().
      // First dedup call: no existing comment. After the write, the comment
      // exists, so the second dedup call finds it and nothing more is written.
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (commentsByKey.size === 0 ? [] : [{}]),
            orderBy: () => ({
              limit: async () => [{ id: "issue-1", identifier: "TASK-1" }],
            }),
          }),
        }),
      }),
    } as never;

    const input = {
      companyId: "c0000000-0000-4000-8000-000000000000",
      status: status({ inProgress: 2, wip: 2, limit: 1, overLimit: true }),
      agentName: "Alpha",
    };

    const first = await deliverWipLimitSignal(db, ports, input);
    expect(first.written).toBe(true);
    expect(written).toEqual([wipLimitSignalKey(AGENT_A, windowStart)]);

    const second = await deliverWipLimitSignal(db, ports, input);
    expect(second.written).toBe(false);
    expect(written).toHaveLength(1);
  });
});

describe("myrmidon(1.6.1-WIP-LIMIT-A) sweep gate", () => {
  it("all-null settings are detected as count-only", () => {
    expect(wipLimitsAllDisabled({ defaultLimit: null, perAgent: {} })).toBe(true);
    expect(wipLimitsAllDisabled({ defaultLimit: null, perAgent: { [AGENT_A]: null } })).toBe(true);
    expect(wipLimitsAllDisabled({ defaultLimit: 2, perAgent: {} })).toBe(false);
    expect(wipLimitsAllDisabled({ defaultLimit: null, perAgent: { [AGENT_A]: 1 } })).toBe(false);
  });

  it("the interval gate skips a pass that comes too soon", async () => {
    const deps = {
      db: {
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
      } as never,
      settings: { getGeneral: async () => ({}), updateGeneral: async () => ({}) } as never,
      addComment: async () => ({}),
    };
    const sweeper = createWipLimitSweeper({ ...deps, intervalMs: 60_000 });
    const t0 = new Date("2026-10-03T12:00:00Z");
    const first = await sweeper.sweep(t0);
    expect(first.skipped).toBe(false);
    const tooSoon = await sweeper.sweep(new Date(t0.getTime() + 30_000));
    expect(tooSoon.skipped).toBe(true);
    const onTime = await sweeper.sweep(new Date(t0.getTime() + 90_000), { force: true });
    expect(onTime.skipped).toBe(false);
  });
});
