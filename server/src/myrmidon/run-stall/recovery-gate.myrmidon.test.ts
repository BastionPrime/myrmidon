// The stall interrupt must be treated as resumable: without the exemption in
// the vendor's reconciliation gate a stalled run would be settled as
// replay-blocked (part B), which is exactly what the feature must not do.

import { describe, expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "../../services/legacy-execution-recovery.js";
import { RUN_STALL_ERROR_CODE } from "./constants.js";

const CONVERSATION_RUN = {
  runtimeMode: "legacy",
  status: "cancelled",
  errorCode: RUN_STALL_ERROR_CODE,
  resultJson: null,
  scheduledRetryAttempt: 0,
  scheduledRetryReason: null,
  contextSnapshot: null,
  runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
};

describe("run stall: the reconciliation gate", () => {
  it("does not hold a run interrupted by the stall sweep", () => {
    expect(legacyExecutionNeedsReconciliation(CONVERSATION_RUN)).toBe(false);
  });

  it("still holds an ordinary cancelled run", () => {
    expect(
      legacyExecutionNeedsReconciliation({
        ...CONVERSATION_RUN,
        errorCode: "provider_error",
        runnerProfileJson: { adapterDispatch: { adapterType: "process" } },
      }),
    ).toBe(true);
  });

  it("keeps the exemption even after the retry budget is spent, like the maintenance code", () => {
    // The maintenance interruption is exempted unconditionally, and a stall is
    // the same kind of event: the sweep re-opens the task itself, so there is
    // nothing for an operator to reconcile no matter how often it fired.
    expect(
      legacyExecutionNeedsReconciliation({
        ...CONVERSATION_RUN,
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "failure",
      }),
    ).toBe(false);
  });

  it("does not hold a run that is still alive", () => {
    expect(legacyExecutionNeedsReconciliation({ ...CONVERSATION_RUN, status: "running" })).toBe(false);
  });
});