// myrmidon(1.6-SWARM-CLAIM-B): settings of the supervisor surface.
//
// Part B (the supervisor view, the rebalance action and the pilot report) owns
// its own two knobs. The claim machinery itself — the queue, the lease, the
// TTL, the per-agent limit and the pilot flag — belongs to part A and is read
// from there; this module never invents a second copy of those keys.
//
// The style follows the rest of the 1.6 modules: a numeric setting falls back
// to its default on anything that is not a positive integer, and the pilot
// snapshot document key falls back to its default on an empty value.

/** How many queue candidates one role may report; a ceiling, not a page size. */
export const SWARM_SUPERVISOR_TASK_MAX_ENV = "MYRMIDON_SWARM_SUPERVISOR_TASK_MAX";
export const DEFAULT_SWARM_SUPERVISOR_TASK_MAX = 500;

/** The issue document key that holds the frozen BASELINE snapshot. */
export const SWARM_PILOT_BASELINE_DOC_ENV = "MYRMIDON_SWARM_PILOT_BASELINE_DOC";
export const DEFAULT_SWARM_PILOT_BASELINE_DOC = "baseline-snapshot-14d";

/**
 * Upper bound of the row cap: a caller cannot turn the overview into an
 * unbounded scan by setting a huge value. The default is already 500 roles
 * worth of rows; the ceiling only exists so a typo cannot ask for millions.
 */
export const MAX_SWARM_SUPERVISOR_TASK_MAX = 5000;

export interface SwarmSupervisorSettings {
  /** Rows of queue candidates per role in the overview. */
  taskMax: number;
  /** Issue document key the frozen BASELINE snapshot is read from. */
  baselineDocumentKey: string;
}

export function readSwarmSupervisorSettings(
  env: NodeJS.ProcessEnv = process.env,
): SwarmSupervisorSettings {
  return {
    taskMax: readTaskMax(env),
    baselineDocumentKey: readBaselineDocumentKey(env),
  };
}

function readTaskMax(env: NodeJS.ProcessEnv): number {
  const raw = env[SWARM_SUPERVISOR_TASK_MAX_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SWARM_SUPERVISOR_TASK_MAX;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_SWARM_SUPERVISOR_TASK_MAX;
  return Math.min(value, MAX_SWARM_SUPERVISOR_TASK_MAX);
}

function readBaselineDocumentKey(env: NodeJS.ProcessEnv): string {
  const raw = env[SWARM_PILOT_BASELINE_DOC_ENV]?.trim();
  return raw ? raw : DEFAULT_SWARM_PILOT_BASELINE_DOC;
}