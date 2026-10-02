// Run stall detection (progress-based run liveness, part D of the team-liveness
// feature). See docs/myrmidon/SETTINGS.md.
//
// The board must heal itself: on 01.10 two runs sat for three hours each and the
// only thing that ever noticed was the hard run timeout. A run whose own
// recorded progress (output, run events, useful actions) has not moved for
// `MYRMIDON_RUN_STALL_THRESHOLD_SEC` (default 20 minutes) is interrupted by the
// same chain the maintenance mode uses, the task goes back to `todo`, and the
// assignee is woken so the work resumes through the normal wake path. The hard
// timeout stays as the outer backstop and is not touched here.
//
// Nothing about this sweep measures how long a run has been running: only the
// age of its newest RECORDED progress decides (myrmidon/run-stall/policy.ts),
// so a long working run is never interrupted for being long.
//
// The interrupt is issued as a bounded, resumable stop on the existing
// infrastructure-interrupt family: the error code below is exempted from the
// vendor's "replay blocked" reconciliation hold exactly like the maintenance
// code is (myrmidon/maintenance/domain.ts), and the release is told not to fire
// its immediate escalation because this sweep re-opens the task itself.

/** Error code carried by a run this sweep interrupted. Exempted from the reconciliation hold. */
export const RUN_STALL_ERROR_CODE = "run_stalled";
/** Failure reason recorded on the released environment lease and in the run's stop metadata. */
export const RUN_STALL_FAILURE_REASON = "run_stall_sweep";
/** Wake reason of the wake that puts the interrupted task back in front of its assignee. */
export const RUN_STALL_WAKE_REASON = "run_stalled";
/** Activity-log action written for every interrupted run. */
export const RUN_STALL_ACTIVITY_ACTION = "myrmidon.run_stall.interrupted";
/** Idempotency prefix of that wake; tracing only, the wake's own gates decide admission. */
export const RUN_STALL_WAKE_IDEMPOTENCY_PREFIX = "run_stall";

export const RUN_STALL_INTERRUPT_REASON =
  "Run stalled: no recorded progress within the stall threshold; interrupted so the task can resume";
export const RUN_STALL_WAKE_REASON_DETAIL = "the previous run stalled and was interrupted";