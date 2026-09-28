import { readFileSync } from "node:fs";

/**
 * Instance-wide run admission (myrmidon, stage 0 of per-project containers).
 *
 * The vendor limits concurrent runs per agent only. With local adapters every
 * run is a child process of the server container, so a mass wake of many agents
 * (35 hermes processes on 2026-09-28) exhausts the container memory and the
 * kernel kills the server together with every run. Admission adds instance-wide
 * limits on top of the per-agent one:
 *
 * - MYRMIDON_MAX_CONCURRENT_RUNS: at most N runs started by this process at once;
 * - MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: at most K run starts per sliding minute,
 *   so a restart or a bulk resolve does not start everything in one burst;
 * - MYRMIDON_MIN_FREE_MEMORY_MB: follow the server load. A run starts only if the
 *   server container keeps this much memory free after it; each run is budgeted
 *   at MYRMIDON_RUN_MEMORY_ESTIMATE_MB (default 300). Free memory is the cgroup
 *   limit minus usage without reclaimable inactive page cache.
 *
 * Runs over a limit stay `queued`; the periodic queued-run sweep starts them
 * when a slot frees. Unset, empty or 0 disables a limit.
 *
 * No locks: the server is one Node.js thread, and `reserve` checks and counts
 * without awaiting anything, so two agents cannot both take the last slot.
 */

export const MAX_CONCURRENT_RUNS_ENV = "MYRMIDON_MAX_CONCURRENT_RUNS";
export const MAX_RUN_STARTS_PER_MINUTE_ENV = "MYRMIDON_MAX_RUN_STARTS_PER_MINUTE";
export const MIN_FREE_MEMORY_MB_ENV = "MYRMIDON_MIN_FREE_MEMORY_MB";
export const RUN_MEMORY_ESTIMATE_MB_ENV = "MYRMIDON_RUN_MEMORY_ESTIMATE_MB";

const DEFAULT_RUN_MEMORY_ESTIMATE_MB = 300;
const START_WINDOW_MS = 60_000;
// A run started this recently has not grown into the cgroup memory yet.
const MEMORY_SETTLE_MS = 30_000;
const MB = 1024 * 1024;

function readLimit(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

export interface RunAdmissionLimits {
  maxConcurrentRuns: number | null;
  maxStartsPerMinute: number | null;
  minFreeMemoryMb: number | null;
  runMemoryEstimateMb: number;
}

export function readRunAdmissionLimits(env: NodeJS.ProcessEnv = process.env): RunAdmissionLimits {
  return {
    maxConcurrentRuns: readLimit(env, MAX_CONCURRENT_RUNS_ENV),
    maxStartsPerMinute: readLimit(env, MAX_RUN_STARTS_PER_MINUTE_ENV),
    minFreeMemoryMb: readLimit(env, MIN_FREE_MEMORY_MB_ENV),
    runMemoryEstimateMb: readLimit(env, RUN_MEMORY_ESTIMATE_MB_ENV) ?? DEFAULT_RUN_MEMORY_ESTIMATE_MB,
  };
}

/**
 * Free memory of this process's cgroup (v2) in bytes, or null when unknown
 * (no limit, cgroup v1, not in a container). Inactive page cache is reclaimable
 * and does not count as used. Synchronous on purpose: three tiny kernel files,
 * and no await keeps `reserve` atomic.
 */
export function readCgroupFreeMemoryBytes(
  root = "/sys/fs/cgroup",
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number | null {
  try {
    const maxRaw = readFile(`${root}/memory.max`).trim();
    if (maxRaw === "max") return null;
    const max = Number(maxRaw);
    const current = Number(readFile(`${root}/memory.current`).trim());
    const inactive = Number(/^inactive_file (\d+)$/m.exec(readFile(`${root}/memory.stat`))?.[1] ?? 0);
    if (!Number.isFinite(max) || !Number.isFinite(current)) return null;
    return max - Math.max(0, current - inactive);
  } catch {
    return null;
  }
}

export interface RunAdmission {
  /**
   * How many of `wanted` runs may start now; the slots are taken at once.
   * Hand back the ones not started with `release(unused)`, and call
   * `finish()` once for every started run when it ends.
   */
  reserve(wanted: number): number;
  release(unused: number): void;
  finish(): void;
}

export function createRunAdmission(options: {
  limits: RunAdmissionLimits;
  freeMemoryBytes?: () => number | null;
  now?: () => number;
}): RunAdmission {
  const { limits } = options;
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => readCgroupFreeMemoryBytes());
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  let active = 0;

  function prune(at: number) {
    while (starts.length > 0 && at - starts[0]! >= START_WINDOW_MS) starts.shift();
  }

  return {
    reserve(wanted) {
      if (wanted <= 0) return 0;
      const at = now();
      prune(at);
      let allowed = wanted;
      if (limits.maxConcurrentRuns !== null) {
        allowed = Math.min(allowed, limits.maxConcurrentRuns - active);
      }
      if (limits.maxStartsPerMinute !== null) {
        allowed = Math.min(allowed, limits.maxStartsPerMinute - starts.length);
      }
      if (limits.minFreeMemoryMb !== null && allowed > 0) {
        const free = freeMemoryBytes();
        // Unknown free memory (no cgroup limit) leaves the other limits in charge.
        if (free !== null) {
          const settling = starts.filter((startedAt) => at - startedAt < MEMORY_SETTLE_MS).length;
          const estimate = limits.runMemoryEstimateMb * MB;
          const spare = free - limits.minFreeMemoryMb * MB - settling * estimate;
          allowed = Math.min(allowed, Math.floor(spare / estimate));
        }
      }
      allowed = Math.max(0, allowed);
      active += allowed;
      for (let i = 0; i < allowed; i += 1) starts.push(at);
      return allowed;
    },
    release(unused) {
      if (unused <= 0) return;
      active = Math.max(0, active - unused);
      starts.splice(starts.length - Math.min(unused, starts.length), unused);
    },
    finish() {
      active = Math.max(0, active - 1);
    },
  };
}

let shared: RunAdmission | null = null;

/**
 * One admission per server process: heartbeatService is instantiated by many
 * routes and services, and the counters must be shared by all of them.
 */
export function sharedRunAdmission(): RunAdmission {
  if (!shared) shared = createRunAdmission({ limits: readRunAdmissionLimits() });
  return shared;
}

/** Test hook: drop the process-wide admission so the next call rereads the env. */
export function resetSharedRunAdmissionForTests(): void {
  shared = null;
}
