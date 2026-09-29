// myrmidon(D1): MYRMIDON_CHAT_RECONCILE_INTERVAL_MS setting. See
// docs/myrmidon/SETTINGS.md.

/**
 * Minimum spacing (ms) between runs of the run milestone sweep
 * (enqueueChatRunMilestones), the one chat reconciliation lane this setting
 * throttles: server/src/app.ts passes it only to that lane's coalesced
 * trigger (milestoneMinimumSpacingMs). The publication lane, which also runs
 * the inbound-wakeup notice sweep, keeps its usual pace. The value replaces
 * the trigger's default spacing (100 ms in createCoalescedAsyncTrigger)
 * rather than adding to it. The lane already coalesces concurrent wakeups
 * and skips a tick while a previous pass is still running, so this only
 * matters once a pass is cheap enough to otherwise run back-to-back with
 * nothing to do.
 *
 * Unset (or <= 0, or unparseable) leaves today's spacing untouched: the D1
 * query rewrites (uuid-typed owner join, deduplicated EXISTS checks, indexed
 * and hoisted inbound-link lookup) are the default-on fix for the "scans
 * full history every poll" defect. This setting is an opt-in throttle for a
 * deployment that additionally wants the milestone lane to poll less often
 * while chats are idle — a deployment-specific value, not a new default
 * cadence.
 */
export function chatReconcileMinimumSpacingMs(
  env: { MYRMIDON_CHAT_RECONCILE_INTERVAL_MS?: string } = process.env,
): number | undefined {
  const raw = env.MYRMIDON_CHAT_RECONCILE_INTERVAL_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
