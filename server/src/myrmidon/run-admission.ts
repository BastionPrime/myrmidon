import { readFileSync } from "node:fs";
import {
  RUN_LIMITS_ENV_KEYS,
  readRunLimitsFromEnv,
  type RunLimits,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

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
 * when a slot frees. Unset, empty or 0 disables a limit. When
 * MYRMIDON_MIN_FREE_MEMORY_MB is set but this process cannot read its cgroup
 * limit (memory.max is 'max', cgroup v1, not in a container), the memory guard
 * is inactive and that is logged once, so an operator does not read a silent
 * pass as a working guard (myrmidon(C0)).
 *
 * No locks: the server is one Node.js thread, and `reserve` checks and counts
 * without awaiting anything, so two agents cannot both take the last slot.
 */

export const MAX_CONCURRENT_RUNS_ENV = RUN_LIMITS_ENV_KEYS.maxConcurrentRuns;
export const MAX_RUN_STARTS_PER_MINUTE_ENV = RUN_LIMITS_ENV_KEYS.maxStartsPerMinute;
export const MIN_FREE_MEMORY_MB_ENV = RUN_LIMITS_ENV_KEYS.minFreeMemoryMb;
export const RUN_MEMORY_ESTIMATE_MB_ENV = RUN_LIMITS_ENV_KEYS.runMemoryEstimateMb;

const START_WINDOW_MS = 60_000;
// A run started this recently has not grown into the cgroup memory yet.
const MEMORY_SETTLE_MS = 30_000;
const MB = 1024 * 1024;

export type RunAdmissionLimits = RunLimits;

/** The limits as the environment declares them, with the built-in defaults. */
export function readRunAdmissionLimits(env: NodeJS.ProcessEnv = process.env): RunAdmissionLimits {
  return readRunLimitsFromEnv(env);
}

/** Why the memory guard cannot see a limit; `reason` goes to the log verbatim. */
export type CgroupMemoryLimit =
  | { known: true; freeBytes: number }
  | { known: false; reason: string };

/**
 * Free memory of this process's cgroup (v2) in bytes, or the reason it is
 * unknown (no limit, cgroup v1, not in a container). Inactive page cache is
 * reclaimable and does not count as used. Synchronous on purpose: three tiny
 * kernel files, and no await keeps `reserve` atomic.
 *
 * myrmidon(C0): the reason matters. With `MYRMIDON_MIN_FREE_MEMORY_MB` set and
 * no visible limit the memory guard silently does nothing, and an operator
 * cannot tell that from a guard that passes. The reason is logged once by
 * `createRunAdmission` (see below) instead of being dropped.
 */
export function readCgroupMemoryLimit(
  root = "/sys/fs/cgroup",
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): CgroupMemoryLimit {
  let maxRaw: string;
  try {
    maxRaw = readFile(`${root}/memory.max`).trim();
  } catch {
    return {
      known: false,
      reason: `${root}/memory.max is not readable: cgroup v1, or this process is not in a cgroup`,
    };
  }
  if (maxRaw === "max") {
    return {
      known: false,
      reason: `${root}/memory.max is 'max': the cgroup of this process has no memory limit, so MYRMIDON_MIN_FREE_MEMORY_MB cannot be enforced`,
    };
  }
  const max = Number(maxRaw);
  if (!Number.isFinite(max)) {
    return { known: false, reason: `${root}/memory.max is not a number: '${maxRaw}'` };
  }
  let current: number;
  let inactive: number;
  try {
    current = Number(readFile(`${root}/memory.current`).trim());
    inactive = Number(/^inactive_file (\d+)$/m.exec(readFile(`${root}/memory.stat`))?.[1] ?? 0);
  } catch {
    return {
      known: false,
      reason: `${root}/memory.current or memory.stat is not readable, so free memory cannot be counted`,
    };
  }
  if (!Number.isFinite(current)) {
    return { known: false, reason: `${root}/memory.current is not a number: '${current}'` };
  }
  return { known: true, freeBytes: max - Math.max(0, current - inactive) };
}

/**
 * Free memory of this process's cgroup (v2) in bytes, or null when unknown.
 * Thin wrapper over `readCgroupMemoryLimit` for callers that only need the
 * number; the reason is available there.
 */
export function readCgroupFreeMemoryBytes(
  root = "/sys/fs/cgroup",
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number | null {
  const limit = readCgroupMemoryLimit(root, readFile);
  return limit.known ? limit.freeBytes : null;
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
  /**
   * Raise the in-process count to the runs the database has in `running`: an
   * execution can settle while its row is still running (hand-off, deferred
   * finish), and the count must not drift below reality.
   */
  syncRunning(running: number): void;
  /** True when the last `reserve` gave fewer slots than wanted because of a limit. */
  limited(): boolean;
  /**
   * Replace the limits in force. Written into the object `reserve` reads, so
   * the next reservation sees the new ceiling without a restart (no run in
   * flight has to be dropped) and without re-creating the singleton, which
   * would lose the running count and the start window.
   */
  updateLimits(next: RunAdmissionLimits): void;
  /** The limits in force right now, as a copy. */
  limits(): RunAdmissionLimits;
}

export function createRunAdmission(options: {
  limits: RunAdmissionLimits;
  freeMemoryBytes?: () => number | null;
  /** Called when the memory guard cannot read a limit, so it stays inactive. */
  onMemoryLimitUnavailable?: () => void;
  now?: () => number;
}): RunAdmission {
  const { limits } = options;
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => readCgroupFreeMemoryBytes());
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  let active = 0;
  let lastLimited = false;

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
        } else {
          // myrmidon(C0): the guard is inactive, and that must be visible.
          options.onMemoryLimitUnavailable?.();
        }
      }
      allowed = Math.max(0, allowed);
      lastLimited = allowed < wanted;
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
    syncRunning(running) {
      // Only raise: lowering could drop slots reserved for claims still in flight.
      if (Number.isInteger(running) && running > active) active = running;
    },
    limited() {
      return lastLimited;
    },
    updateLimits(next) {
      limits.maxConcurrentRuns = next.maxConcurrentRuns;
      limits.maxStartsPerMinute = next.maxStartsPerMinute;
      limits.minFreeMemoryMb = next.minFreeMemoryMb;
      limits.runMemoryEstimateMb = next.runMemoryEstimateMb;
    },
    limits() {
      return { ...limits };
    },
  };
}

const RESWEEP_DELAY_MS = 15_000;
let resweepTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run `sweep` once after a short delay, when admission held runs back. One
 * pending timer per process: repeated calls before it fires do nothing.
 */
export function scheduleQueuedResweep(sweep: () => unknown, delayMs = RESWEEP_DELAY_MS): void {
  if (resweepTimer) return;
  resweepTimer = setTimeout(() => {
    resweepTimer = null;
    void sweep();
  }, delayMs);
  resweepTimer.unref?.();
}

let shared: RunAdmission | null = null;

// myrmidon(C0): the memory guard is inactive when the cgroup limit is not
// visible to the process (memory.max is 'max', cgroup v1, or not in a
// container). That is a normal configuration, not a failure, so it is logged
// once per process instead of being dropped: with MYRMIDON_MIN_FREE_MEMORY_MB
// set and no visible limit, the cap rests on the concurrency and start-rate
// limits alone, and nothing else tells an operator about it.
let memoryLimitWarningLogged = false;

function warnMemoryLimitUnavailableOnce(): void {
  if (memoryLimitWarningLogged) return;
  memoryLimitWarningLogged = true;
  const limit = readCgroupMemoryLimit();
  logger.warn(
    {
      env: MIN_FREE_MEMORY_MB_ENV,
      reason: limit.known
        ? "the cgroup limit disappeared between two reads of the same file"
        : limit.reason,
    },
    "run admission cannot read the cgroup memory limit: the free-memory guard is inactive, only the concurrency and start-rate limits apply",
  );
}

/**
 * One admission per server process: heartbeatService is instantiated by many
 * routes and services, and the counters must be shared by all of them.
 */
export function sharedRunAdmission(): RunAdmission {
  if (!shared) {
    shared = createRunAdmission({
      limits: readRunAdmissionLimits(),
      onMemoryLimitUnavailable: warnMemoryLimitUnavailableOnce,
    });
  }
  return shared;
}

/** Test hook: drop the process-wide admission so the next call rereads the env. */
export function resetSharedRunAdmissionForTests(): void {
  shared = null;
  memoryLimitWarningLogged = false;
}

/**
 * Put limits in force on the process-wide admission (myrmidon C0,
 * RUNTIME-LIMITS). The server calls this at startup, after reading
 * `instance_settings.general.runLimits`, and again on every settings write, so
 * a changed ceiling reaches the queue without a restart. Called before any
 * route has touched the admission, it creates the singleton with these values
 * instead of the environment ones.
 */
export function applyRunAdmissionLimits(limits: RunAdmissionLimits): void {
  sharedRunAdmission().updateLimits(limits);
}

/** The limits the process-wide admission enforces right now. */
export function currentRunAdmissionLimits(): RunAdmissionLimits {
  return sharedRunAdmission().limits();
}
