/**
 * Merged workspace copy lifecycle (WORKSPACE-HYGIENE part B).
 *
 * The vendor terminal-workspace reaper waits a single cooldown
 * (`PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS`, seven days by default) after an
 * issue tree becomes terminal before it archives the workspace, no matter
 * whether the branch was already merged. Merged copies then sit on disk for a
 * week, and 34 GB of merged working copies filled the development host.
 *
 * This module holds the pure rules the reaper calls:
 *
 * - a short cooldown for copies whose delivery state is `merged_via_pr` or
 *   `merged_by_ancestry` (default 30 minutes, `MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS`,
 *   `0` reaps on the next sweep), while every other terminal copy keeps the
 *   seven-day cooldown;
 * - the decision to write a once-a-day activity-log signal for a terminal copy
 *   that stays undeletable (dirty tree or undelivered work) past
 *   `MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS` (24 hours by default).
 *
 * The reaper never archives a copy with a dirty tree or an unmerged/unknown
 * delivery state: that guard runs before the cooldown in both the loop and the
 * guarded archive statement. Neither cooldown, short or long, relaxes it.
 */

export const MERGED_WORKSPACE_COOLDOWN_ENV = "MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS";
export const STUCK_WORKSPACE_SIGNAL_AFTER_ENV = "MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS";

/** Default cooldown for a copy whose branch is already merged: 30 minutes. */
export const DEFAULT_MERGED_WORKSPACE_COOLDOWN_MS = 30 * 60 * 1000;
/** Default wait before a stuck, undeletable terminal copy is signalled: 24 hours. */
export const DEFAULT_STUCK_WORKSPACE_SIGNAL_AFTER_MS = 24 * 60 * 60 * 1000;
/** A repeated signal for the same copy waits at least this long: 24 hours. */
export const STUCK_WORKSPACE_SIGNAL_REPEAT_MS = 24 * 60 * 60 * 1000;

/**
 * Metadata key that records when the reaper last signalled a stuck,
 * undeletable copy. It lives in the workspace `metadata` JSON so the throttle
 * needs no schema migration.
 */
export const WORKSPACE_STUCK_SIGNAL_METADATA_KEY = "workspaceStuckSignalAt";

const MERGED_DELIVERY_STATES = new Set(["merged_via_pr", "merged_by_ancestry"]);

/** True when the delivery state means the work is already on the base branch. */
export function isMergedDeliveryState(deliveryState: string | null | undefined): boolean {
  return typeof deliveryState === "string" && MERGED_DELIVERY_STATES.has(deliveryState);
}

/**
 * Pick the reaper cooldown for one copy: the short merged cooldown when the
 * work is merged, the caller's default cooldown otherwise. A value of `0` for
 * the chosen cooldown disables the wait, so the reaper archives on the same
 * sweep. Negative values never widen a window: they read as `0`.
 */
export function resolveWorkspaceReaperCooldownMs(input: {
  deliveryState: string | null | undefined;
  defaultCooldownMs: number;
  mergedCooldownMs: number;
}): number {
  const cooldownMs = isMergedDeliveryState(input.deliveryState)
    ? input.mergedCooldownMs
    : input.defaultCooldownMs;
  return Math.max(0, cooldownMs);
}

/**
 * Read a millisecond duration from an environment string. An empty,
 * whitespace-only, negative, fractional or non-numeric value falls back to the
 * given default.
 */
export function readDurationMsFromEnv(
  raw: string | undefined,
  fallbackMs: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallbackMs;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : fallbackMs;
}

/** Merged-copy cooldown in milliseconds; invalid values fall back to 30 minutes. */
export function readMergedWorkspaceCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  return readDurationMsFromEnv(env[MERGED_WORKSPACE_COOLDOWN_ENV], DEFAULT_MERGED_WORKSPACE_COOLDOWN_MS);
}

/** Stuck-copy signal threshold in milliseconds; invalid values fall back to 24 hours. */
export function readStuckWorkspaceSignalAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  return readDurationMsFromEnv(env[STUCK_WORKSPACE_SIGNAL_AFTER_ENV], DEFAULT_STUCK_WORKSPACE_SIGNAL_AFTER_MS);
}

/** Read the time of the last stuck-copy signal; null when absent or invalid. */
export function readWorkspaceStuckSignalAt(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  const raw = metadata?.[WORKSPACE_STUCK_SIGNAL_METADATA_KEY];
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when a terminal copy has stayed undeletable long enough that the reaper
 * should signal it. A threshold of `0` signals as soon as the copy is terminal.
 * Returns false for an unknown anchor: without a terminal timestamp the reaper
 * cannot tell how long the copy has been stuck.
 */
export function isWorkspaceStuckLongEnough(input: {
  anchorMs: number | null;
  nowMs: number;
  stuckAfterMs: number;
}): boolean {
  if (input.anchorMs === null) return false;
  return input.anchorMs <= input.nowMs - Math.max(0, input.stuckAfterMs);
}

/**
 * Throttle the signal to at most one write per copy per repeat window. A copy
 * with no recorded signal is due; a copy whose last signal is older than the
 * window is due again.
 */
export function shouldEmitWorkspaceStuckSignal(input: {
  metadata: Record<string, unknown> | null | undefined;
  nowMs: number;
  repeatAfterMs: number;
}): boolean {
  const lastSignalAt = readWorkspaceStuckSignalAt(input.metadata);
  if (lastSignalAt === null) return true;
  return lastSignalAt <= input.nowMs - Math.max(0, input.repeatAfterMs);
}

/** Return a metadata object recording a stuck-copy signal at `atMs`, keeping every other key. */
export function markWorkspaceStuckSignal(
  metadata: Record<string, unknown> | null | undefined,
  atMs: number,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [WORKSPACE_STUCK_SIGNAL_METADATA_KEY]: new Date(atMs).toISOString(),
  };
}