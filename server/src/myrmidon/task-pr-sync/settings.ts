// Task PR sync settings (MYRMIDON_TASK_PR_SYNC_*). See docs/myrmidon/SETTINGS.md.
//
// The feature is a defect fix (CONVENTIONS.md §8): a task whose delivering PR
// merged should close itself instead of waiting for a person. It therefore ships
// enabled, and only an explicit off value disables it. The poll interval is a
// deployment value with a neutral default (60 s), tuned from env like its
// siblings.

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

export const TASK_PR_SYNC_ENABLED_ENV = "MYRMIDON_TASK_PR_SYNC_ENABLED";
export const TASK_PR_SYNC_POLL_SEC_ENV = "MYRMIDON_TASK_PR_SYNC_POLL_SEC";
export const TASK_PR_SYNC_BATCH_MAX_ENV = "MYRMIDON_TASK_PR_SYNC_BATCH_MAX";
// Documented by name for the operator: a task that carries a deliberately still-open
// post-deploy gate must not be settled even when all of its PRs are merged. The
// sweep detects such a gate from the task's own review path (a pending approval, a
// pending issue-thread card, a live scheduled monitor) and defers; this switch is
// the blunt instance-wide way to defer *every* settle at once (rollback lever).
export const TASK_PR_SYNC_SETTLE_DISABLED_ENV = "MYRMIDON_TASK_PR_SYNC_SETTLE_DISABLED";

/** A scheduler queue ticks at roughly 15 s; 60 s keeps the pass cheap without lagging a merge by minutes. */
export const DEFAULT_TASK_PR_SYNC_POLL_SEC = 60;
export const MIN_TASK_PR_SYNC_POLL_SEC = 15;

/** At most this many tasks per pass (each task costs one GitHub resolve per PR). */
export const DEFAULT_TASK_PR_SYNC_BATCH_MAX = 50;
export const MAX_TASK_PR_SYNC_BATCH_MAX = 500;

export interface TaskPrSyncSettings {
  enabled: boolean;
  /** When true, the sweep still reads and logs but never flips a task to done. */
  settleDisabled: boolean;
  /** Minimum spacing between two passes. */
  pollMs: number;
  /** Ceiling on tasks inspected in one pass. */
  batchMax: number;
}

/**
 * Master switch. Unset or an unrecognized value keeps the fix on: a typo must not
 * silently extinguish it (`MYRMIDON_RUN_STALL_ENABLED` follows the same rule).
 */
export function readTaskPrSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TASK_PR_SYNC_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/** The blunt settle kill switch; any explicit truthy spelling turns settling off. */
export function readTaskPrSyncSettleDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TASK_PR_SYNC_SETTLE_DISABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function readTaskPrSyncSettings(env: NodeJS.ProcessEnv = process.env): TaskPrSyncSettings {
  return {
    enabled: readTaskPrSyncEnabled(env),
    settleDisabled: readTaskPrSyncSettleDisabled(env),
    pollMs:
      readInt(
        env,
        TASK_PR_SYNC_POLL_SEC_ENV,
        DEFAULT_TASK_PR_SYNC_POLL_SEC,
        MIN_TASK_PR_SYNC_POLL_SEC,
        Number.MAX_SAFE_INTEGER,
      ) * 1000,
    batchMax: readInt(
      env,
      TASK_PR_SYNC_BATCH_MAX_ENV,
      DEFAULT_TASK_PR_SYNC_BATCH_MAX,
      1,
      MAX_TASK_PR_SYNC_BATCH_MAX,
    ),
  };
}