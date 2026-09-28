// myrmidon(D1): MYRMIDON_CHAT_RECONCILE_INTERVAL_MS setting. See
// docs/myrmidon/SETTINGS.md.

/**
 * Extra minimum spacing (ms) between runs of the two most expensive chat
 * reconciliation lanes — the inbound-wakeup notice sweep and the run
 * milestone sweep (server/src/app.ts, chat-channels.ts,
 * chat-run-publications.ts) — on top of each lane's own default spacing.
 * Both lanes already coalesce concurrent wakeups and skip a tick while a
 * previous pass is still running, so this only matters once a pass is cheap
 * enough to otherwise run back-to-back with nothing to do.
 *
 * Unset (or <= 0, or unparseable) leaves today's spacing untouched: the D1
 * query rewrites (uuid-typed owner join, deduplicated EXISTS checks, indexed
 * and hoisted inbound-link lookup) are the default-on fix for the "scans
 * full history every poll" defect. This setting is an opt-in throttle for a
 * deployment that additionally wants these lanes to poll less often while
 * chats are idle — a deployment-specific value, not a new default cadence.
 */
export function chatReconcileMinimumSpacingMs(
  env: Pick<NodeJS.ProcessEnv, "MYRMIDON_CHAT_RECONCILE_INTERVAL_MS"> = process.env,
): number | undefined {
  const raw = env.MYRMIDON_CHAT_RECONCILE_INTERVAL_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
