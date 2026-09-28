// myrmidon(L1): legacyExecutionNeedsReconciliation no longer holds a run
// terminated by an infrastructure interruption, mirroring the existing R3
// maintenance-interrupt exception in legacy-execution-recovery.test.ts.
import { expect, it, describe } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const baseRun = { runtimeMode: "legacy", status: "cancelled" as const, resultJson: {} };

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
});
