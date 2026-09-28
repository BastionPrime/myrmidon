import { expect, it, describe } from "vitest";
import {
  DEFAULT_INFRA_INTERRUPT_ERROR_CODES,
  INFRA_INTERRUPT_CONTEXT_ATTEMPT_KEY,
  infraInterruptAttemptCount,
  infraInterruptRetryBudgetExhausted,
  isInfraInterruptErrorCode,
  parseInfraInterruptCodes,
  shouldRetryOriginalExecutorForInfraInterrupt,
  shouldSkipReconciliationForInfraInterrupt,
} from "./infra-interrupts.js";

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
  it("skips the reconciliation hold for a fresh infra-interrupted run", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({ errorCode: "agent_paused", scheduledRetryAttempt: 0 }),
    ).toBe(true);
  });

  it("keeps the hold once the shared retry budget is exhausted", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({ errorCode: "agent_paused", scheduledRetryAttempt: 2 }),
    ).toBe(false);
  });

  it("keeps the hold for a run that failed for a non-infrastructure reason", () => {
    expect(
      shouldSkipReconciliationForInfraInterrupt({ errorCode: "adapter_failed", scheduledRetryAttempt: 0 }),
    ).toBe(false);
  });

  it("falls back to the vendor behavior when the setting is turned off", () => {
    const env = { MYRMIDON_INFRA_INTERRUPT_CODES: "off" } as NodeJS.ProcessEnv;
    expect(
      shouldSkipReconciliationForInfraInterrupt({ errorCode: "agent_paused", scheduledRetryAttempt: 0 }, env),
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
      }),
    ).toBe(false);
  });
});

describe("shouldRetryOriginalExecutorForInfraInterrupt", () => {
  it("retries the original executor for a pause, a lost process, or a shutdown", () => {
    for (const errorCode of ["agent_paused", "process_lost", "server_shutdown_interrupted"]) {
      expect(
        shouldRetryOriginalExecutorForInfraInterrupt({ errorCode, scheduledRetryAttempt: 0 }),
      ).toBe(true);
    }
  });

  it("never schedules the original executor a retry on reassignment: the new assignee wakes itself", () => {
    expect(
      shouldRetryOriginalExecutorForInfraInterrupt({ errorCode: "issue_reassigned", scheduledRetryAttempt: 0 }),
    ).toBe(false);
  });

  it("keeps the vendor behavior once the retry budget is exhausted", () => {
    expect(
      shouldRetryOriginalExecutorForInfraInterrupt({ errorCode: "agent_paused", scheduledRetryAttempt: 2 }),
    ).toBe(false);
  });
});
