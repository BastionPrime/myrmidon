import { expect, it, describe } from "vitest";
import {
  adapterQualifiesForInfraInterruptRelief,
  DEFAULT_INFRA_INTERRUPT_ERROR_CODES,
  INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY,
  infraInterruptAttemptCount,
  infraInterruptRetryBudgetExhausted,
  isInfraInterruptErrorCode,
  parseInfraInterruptCodes,
  shouldRetryOriginalExecutorForInfraInterrupt,
  shouldSkipReconciliationForInfraInterrupt,
} from "./infra-interrupts.js";

// A conversation adapter (services/conversation-continuation.ts's
// CONVERSATION_ADAPTER_TYPES) hands the provider a fresh turn instead of
// blindly replaying whatever the interrupted attempt already did, so this
// exception only applies to a run claimed by one of these.
function runnerProfileFor(adapterType: string): Record<string, unknown> {
  return { adapterDispatch: { adapterType } };
}
const dialogAdapterRun = { runnerProfileJson: runnerProfileFor("hermes_local") };
const gatewayAdapterRun = { runnerProfileJson: runnerProfileFor("openclaw_gateway") };
const processAdapterRun = { runnerProfileJson: runnerProfileFor("process") };

describe("parseInfraInterruptCodes", () => {
  it("defaults to the four documented codes when unset", () => {
    expect(parseInfraInterruptCodes(undefined)).toEqual(new Set(DEFAULT_INFRA_INTERRUPT_ERROR_CODES));
  });

  it.each(["", "  ", "off", "OFF", " Off "])("disables the exception for %j", (raw) => {
    expect(parseInfraInterruptCodes(raw)).toEqual(new Set());
  });

  it("parses a custom comma-separated list, trimming whitespace and dropping empties", () => {
    expect(parseInfraInterruptCodes(" agent_paused ,, process_lost ,")).toEqual(
      new Set(["agent_paused", "process_lost"]),
    );
  });
});

describe("isInfraInterruptErrorCode", () => {
  it.each(DEFAULT_INFRA_INTERRUPT_ERROR_CODES)("matches the default code %s", (code) => {
    expect(isInfraInterruptErrorCode(code)).toBe(true);
  });

  it("does not match an unrelated provider failure code", () => {
    expect(isInfraInterruptErrorCode("adapter_failed")).toBe(false);
  });

  it("does not match null or undefined", () => {
    expect(isInfraInterruptErrorCode(null)).toBe(false);
    expect(isInfraInterruptErrorCode(undefined)).toBe(false);
  });

  it("honors a narrower configured list", () => {
    const env = { MYRMIDON_INFRA_INTERRUPT_CODES: "agent_paused" } as NodeJS.ProcessEnv;
    expect(isInfraInterruptErrorCode("agent_paused", env)).toBe(true);
    expect(isInfraInterruptErrorCode("process_lost", env)).toBe(false);
  });

  it("matches nothing when the setting is disabled (vendor behavior)", () => {
    const env = { MYRMIDON_INFRA_INTERRUPT_CODES: "off" } as NodeJS.ProcessEnv;
    expect(isInfraInterruptErrorCode("agent_paused", env)).toBe(false);
  });
});

describe("infraInterruptAttemptCount", () => {
  it("falls back to scheduledRetryAttempt when no carried-forward context is present", () => {
    expect(infraInterruptAttemptCount({ scheduledRetryAttempt: 1 })).toBe(1);
    expect(infraInterruptAttemptCount({ scheduledRetryAttempt: 0, contextSnapshot: null })).toBe(0);
  });

  it("reads the count pause-drain.ts's resumeAgentAfterPause carries forward across a resume", () => {
    expect(
      infraInterruptAttemptCount({
        scheduledRetryAttempt: 0,
        contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: 1 },
      }),
    ).toBe(1);
  });

  it("takes whichever of the two sources is higher", () => {
    expect(
      infraInterruptAttemptCount({
        scheduledRetryAttempt: 3,
        contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: 1 },
      }),
    ).toBe(3);
  });

  it("ignores a malformed or negative carried-forward value", () => {
    expect(
      infraInterruptAttemptCount({ scheduledRetryAttempt: 0, contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: -1 } }),
    ).toBe(0);
    expect(
      infraInterruptAttemptCount({ scheduledRetryAttempt: 0, contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: "2" } }),
    ).toBe(0);
  });
});

describe("infraInterruptRetryBudgetExhausted", () => {
  it("is not exhausted below the default budget of 2", () => {
    expect(infraInterruptRetryBudgetExhausted({ scheduledRetryAttempt: 0 })).toBe(false);
    expect(infraInterruptRetryBudgetExhausted({ scheduledRetryAttempt: 1 })).toBe(false);
  });

  it("is exhausted at or above the default budget of 2, matching legacyExecutionNeedsReconciliation", () => {
    expect(infraInterruptRetryBudgetExhausted({ scheduledRetryAttempt: 2 })).toBe(true);
    expect(infraInterruptRetryBudgetExhausted({ scheduledRetryAttempt: 3 })).toBe(true);
  });

  it("honors an explicit budget override", () => {
    expect(infraInterruptRetryBudgetExhausted({ scheduledRetryAttempt: 1 }, 1)).toBe(true);
  });

  it("is exhausted from the pause/resume carried-forward count alone, even with scheduledRetryAttempt still at 0", () => {
    // The shape a run created by resumeAgentAfterPause actually has: it is a
    // brand-new heartbeat run (scheduledRetryAttempt defaults to 0), not a
    // scheduleBoundedRetryForRun continuation, so only the carried-forward
    // context field reflects how many pause/resume cycles this issue has
    // already been through.
    expect(
      infraInterruptRetryBudgetExhausted({
        scheduledRetryAttempt: 0,
        contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: 2 },
      }),
    ).toBe(true);
    expect(
      infraInterruptRetryBudgetExhausted({
        scheduledRetryAttempt: 0,
        contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: 1 },
      }),
    ).toBe(false);
  });
});

describe("shouldSkipReconciliationForInfraInterrupt", () => {
  it("skips the reconciliation hold for a fresh infra-interrupted run claimed by a conversation adapter", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({
        errorCode: "agent_paused",
        scheduledRetryAttempt: 0,
        ...dialogAdapterRun,
      }),
    ).toBe(true);
  });

  it("keeps the hold once the shared retry budget is exhausted", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({
        errorCode: "agent_paused",
        scheduledRetryAttempt: 2,
        ...dialogAdapterRun,
      }),
    ).toBe(false);
  });

  it("keeps the hold for a run that failed for a non-infrastructure reason", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({
        errorCode: "adapter_failed",
        scheduledRetryAttempt: 0,
        ...dialogAdapterRun,
      }),
    ).toBe(false);
  });

  it("falls back to the vendor behavior when the setting is turned off", () => {
    const env = { MYRMIDON_INFRA_INTERRUPT_CODES: "off" } as NodeJS.ProcessEnv;
    expect(
      shouldSkipReconciliationForInfraInterrupt(
        { errorCode: "agent_paused", scheduledRetryAttempt: 0, ...dialogAdapterRun },
        env,
      ),
    ).toBe(false);
  });

  it("keeps the hold once a pause/resume cycle's carried-forward count alone exhausts the budget", () => {
    // The exact shape legacy-execution-recovery.ts and recovery/service.ts
    // see for a run created by resumeAgentAfterPause after two prior
    // pause/resume cycles: a fresh run (scheduledRetryAttempt: 0) whose
    // contextSnapshot carries the count forward instead.
    expect(
      shouldSkipReconciliationForInfraInterrupt({
        errorCode: "agent_paused",
        scheduledRetryAttempt: 0,
        contextSnapshot: { [INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY]: 2 },
        ...dialogAdapterRun,
      }),
    ).toBe(false);
  });

  // Senior review, round 1: the exception must not apply to an adapter the
  // vendor forbids a blind retry for (process/webhook-style: retrying one
  // "can replay the action itself", CONVERSATION_ADAPTER_TYPES's own
  // comment) -- regardless of which infra-interrupt code ended the run.
  it.each(["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"])(
    "keeps the vendor hold for a non-conversation adapter (openclaw_gateway) even within budget, for %s",
    (errorCode) => {
      expect(
        shouldSkipReconciliationForInfraInterrupt({
          errorCode,
          scheduledRetryAttempt: 0,
          ...gatewayAdapterRun,
        }),
      ).toBe(false);
    },
  );

  it.each(["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"])(
    "keeps the vendor hold for a non-conversation adapter (process) even within budget, for %s",
    (errorCode) => {
      expect(
        shouldSkipReconciliationForInfraInterrupt({
          errorCode,
          scheduledRetryAttempt: 0,
          ...processAdapterRun,
        }),
      ).toBe(false);
    },
  );

  it("keeps the vendor hold when the run's adapter was never claimed (no runnerProfileJson)", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({ errorCode: "agent_paused", scheduledRetryAttempt: 0 }),
    ).toBe(false);
  });
});

describe("adapterQualifiesForInfraInterruptRelief", () => {
  it("qualifies every conversation adapter", () => {
    for (const adapterType of [
      "claude_local", "codex_local", "cursor", "gemini_local", "opencode_local",
      "pi_local", "grok_local", "kimi_local", "hermes_local",
    ]) {
      expect(
        adapterQualifiesForInfraInterruptRelief({ runnerProfileJson: runnerProfileFor(adapterType) }),
      ).toBe(true);
    }
  });

  it("does not qualify a process/webhook-style adapter", () => {
    expect(adapterQualifiesForInfraInterruptRelief(gatewayAdapterRun)).toBe(false);
    expect(adapterQualifiesForInfraInterruptRelief(processAdapterRun)).toBe(false);
  });

  it("does not qualify when no adapter was claimed", () => {
    expect(adapterQualifiesForInfraInterruptRelief({})).toBe(false);
    expect(adapterQualifiesForInfraInterruptRelief({ runnerProfileJson: null })).toBe(false);
  });
});

describe("shouldRetryOriginalExecutorForInfraInterrupt", () => {
  it("retries the original executor for a pause, a lost process, or a shutdown, on a conversation adapter", () => {
    for (const errorCode of ["agent_paused", "process_lost", "server_shutdown_interrupted"]) {
      expect(
        shouldRetryOriginalExecutorForInfraInterrupt({ errorCode, scheduledRetryAttempt: 0, ...dialogAdapterRun }),
      ).toBe(true);
    }
  });

  it("never schedules the original executor a retry on reassignment: the new assignee wakes itself", () => {
    expect(
      shouldRetryOriginalExecutorForInfraInterrupt({
        errorCode: "issue_reassigned",
        scheduledRetryAttempt: 0,
        ...dialogAdapterRun,
      }),
    ).toBe(false);
  });

  it("keeps the vendor behavior once the retry budget is exhausted", () => {
    expect(
      shouldRetryOriginalExecutorForInfraInterrupt({
        errorCode: "agent_paused",
        scheduledRetryAttempt: 2,
        ...dialogAdapterRun,
      }),
    ).toBe(false);
  });

  // Senior review, round 1: a paused process/webhook-style adapter must not
  // get a blind retry of its original executor -- that would replay the
  // external action the interrupted run may already have taken.
  it("does not retry a paused non-conversation adapter (process, http, openclaw_gateway, …)", () => {
    expect(
      shouldRetryOriginalExecutorForInfraInterrupt({
        errorCode: "agent_paused",
        scheduledRetryAttempt: 0,
        ...gatewayAdapterRun,
      }),
    ).toBe(false);
  });
});
