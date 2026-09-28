// myrmidon(L1): legacyExecutionNeedsReconciliation no longer holds a run
// terminated by an infrastructure interruption, mirroring the existing R3
// maintenance-interrupt exception in legacy-execution-recovery.test.ts --
// but only for a run claimed by a conversation adapter (or one with its own
// idempotency key): see infra-interrupts.ts's module comment. A run whose
// adapter cannot take a blind retry (process, http, openclaw_gateway, an
// unknown/unclaimed adapter, …) keeps the vendor's hold regardless of the
// error code.
import { expect, it, describe } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

function runnerProfileFor(adapterType: string): Record<string, unknown> {
  return { adapterDispatch: { adapterType } };
}

const baseRun = {
  runtimeMode: "legacy",
  status: "cancelled" as const,
  resultJson: {},
  runnerProfileJson: runnerProfileFor("hermes_local"),
};

describe("legacyExecutionNeedsReconciliation: infrastructure interruptions (L1)", () => {
  it.each(["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"])(
    "does not hold a fresh run interrupted by %s",
    (errorCode) => {
      expect(
        legacyExecutionNeedsReconciliation({ ...baseRun, errorCode, scheduledRetryAttempt: 0 }),
      ).toBe(false);
      expect(
        legacyExecutionNeedsReconciliation({ ...baseRun, errorCode, scheduledRetryAttempt: 1 }),
      ).toBe(false);
    },
  );

  it.each(["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"])(
    "reverts to the vendor hold for %s once the shared retry budget is exhausted",
    (errorCode) => {
      expect(
        legacyExecutionNeedsReconciliation({ ...baseRun, errorCode, scheduledRetryAttempt: 2 }),
      ).toBe(true);
    },
  );

  it("still holds an unrelated provider failure", () => {
    expect(
      legacyExecutionNeedsReconciliation({
        ...baseRun,
        errorCode: "adapter_failed",
        scheduledRetryAttempt: 0,
      }),
    ).toBe(true);
  });

  it.each(["failed", "timed_out", "interrupted", "cancelled"])(
    "does not hold agent_paused regardless of the terminal status (%s)",
    (status) => {
      expect(
        legacyExecutionNeedsReconciliation({
          ...baseRun,
          status,
          errorCode: "agent_paused",
          scheduledRetryAttempt: 0,
        }),
      ).toBe(false);
    },
  );

  it("falls back to the vendor hold-and-ask behavior when the setting is turned off", () => {
    const previous = process.env.MYRMIDON_INFRA_INTERRUPT_CODES;
    process.env.MYRMIDON_INFRA_INTERRUPT_CODES = "off";
    try {
      expect(
        legacyExecutionNeedsReconciliation({
          ...baseRun,
          errorCode: "agent_paused",
          scheduledRetryAttempt: 0,
        }),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MYRMIDON_INFRA_INTERRUPT_CODES;
      else process.env.MYRMIDON_INFRA_INTERRUPT_CODES = previous;
    }
  });

  it("does not hold a native run regardless of its error code (unaffected by this exception)", () => {
    expect(
      legacyExecutionNeedsReconciliation({
        ...baseRun,
        runtimeMode: "native",
        errorCode: "agent_paused",
        scheduledRetryAttempt: 0,
      }),
    ).toBe(false);
  });

  // Senior review, round 1: a process/webhook-style adapter is exactly what
  // the vendor's own CONVERSATION_ADAPTER_TYPES exception protects -- a
  // blind retry "can replay the action itself" -- so this exception must
  // never suppress the hold for one of those, whatever the interrupt code.
  it.each(["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"])(
    "still holds a run claimed by a non-conversation adapter (openclaw_gateway) for %s",
    (errorCode) => {
      expect(
        legacyExecutionNeedsReconciliation({
          ...baseRun,
          errorCode,
          scheduledRetryAttempt: 0,
          runnerProfileJson: runnerProfileFor("openclaw_gateway"),
        }),
      ).toBe(true);
    },
  );

  it.each(["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"])(
    "still holds a run claimed by a non-conversation adapter (process) for %s",
    (errorCode) => {
      expect(
        legacyExecutionNeedsReconciliation({
          ...baseRun,
          errorCode,
          scheduledRetryAttempt: 0,
          runnerProfileJson: runnerProfileFor("process"),
        }),
      ).toBe(true);
    },
  );

  it("still holds a run whose adapter was never claimed (no runnerProfileJson)", () => {
    expect(
      legacyExecutionNeedsReconciliation({
        ...baseRun,
        errorCode: "agent_paused",
        scheduledRetryAttempt: 0,
        runnerProfileJson: null,
      }),
    ).toBe(true);
  });
});
