/**
 * Instance-wide run admission (myrmidon, stage 0 of per-project containers).
 *
 * The vendor limits concurrent runs per agent only. With local adapters every
 * run is a child process of the server container, so a mass wake of many agents
 * (35 hermes processes on 2026-09-28) exhausts the container memory and the
 * kernel kills the server together with every run. Admission adds two
 * instance-wide limits on top of the per-agent one:
 *
 * - MYRMIDON_MAX_CONCURRENT_RUNS: at most N runs in `running` at once;
 * - MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: at most K run starts per sliding minute,
 *   so a restart or a bulk resolve does not start everything in one burst;
 * - MYRMIDON_MIN_FREE_MEMORY_MB: follow the server load. A run starts only if the
 *   server container keeps this much memory free after it; each run is budgeted
 *   at MYRMIDON_RUN_MEMORY_ESTIMATE_MB (default 300). Free memory is the cgroup
 *   limit minus usage without reclaimable inactive page cache.
 *
 * Runs over a limit stay `queued`; the periodic queued-run sweep starts them
 * when a slot frees. Unset, empty or 0 disables a limit.
 */

export const MAX_CONCURRENT_RUNS_ENV = "MYRMIDON_MAX_CONCURRENT_RUNS";
export const MAX_RUN_STARTS_PER_MINUTE_ENV = "MYRMIDON_MAX_RUN_STARTS_PER_MINUTE";
export const MIN_FREE_MEMORY_MB_ENV = "MYRMIDON_MIN_FREE_MEMORY_MB";
export const RUN_MEMORY_ESTIMATE_MB_ENV = "MYRMIDON_RUN_MEMORY_ESTIMATE_MB";

const DEFAULT_RUN_MEMORY_ESTIMATE_MB = 300;
const MB = 1024 * 1024;

const START_WINDOW_MS = 60_000;

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

function hasAnyLimit(limits: RunAdmissionLimits): boolean {
  return (
    limits.maxConcurrentRuns !== null || limits.maxStartsPerMinute !== null || limits.minFreeMemoryMb !== null
  );
}

/**
 * Free memory of this process's cgroup (v2) in bytes, or null when unknown
 * (no limit, cgroup v1, not in a container). Inactive page cache is reclaimable
 * and does not count as used.
 */
export async function readCgroupFreeMemoryBytes(
  root = "/sys/fs/cgroup",
  readFile: (path: string) => Promise<string> = async (path) =>
    (await import("node:fs/promises")).readFile(path, "utf8"),
): Promise<number | null> {
  try {
    const maxRaw = (await readFile(`${root}/memory.max`)).trim();
    if (maxRaw === "max") return null;
    const max = Number(maxRaw);
    const current = Number((await readFile(`${root}/memory.current`)).trim());
    const stat = await readFile(`${root}/memory.stat`);
    const inactive = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0);
    if (!Number.isFinite(max) || !Number.isFinite(current)) return null;
    return max - Math.max(0, current - inactive);
  } catch {
    return null;
  }
}

export interface RunAdmission {
  /**
   * Run `claim` while holding the instance admission lock. `claim` receives the
   * number of runs it may start (already capped by `wanted`) and returns how many
   * it actually started.
   */
  admit(wanted: number, claim: (allowed: number) => Promise<number>): Promise<number>;
}

export function createRunAdmission(options: {
  limits: RunAdmissionLimits;
  countRunningRuns: () => Promise<number>;
  freeMemoryBytes?: () => Promise<number | null>;
  now?: () => number;
}): RunAdmission {
  const { limits, countRunningRuns } = options;
  const freeMemoryBytes = options.freeMemoryBytes ?? (() => readCgroupFreeMemoryBytes());
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  let tail: Promise<unknown> = Promise.resolve();

  function startsInWindow(at: number): number {
    while (starts.length > 0 && at - starts[0]! >= START_WINDOW_MS) starts.shift();
    return starts.length;
  }

  async function allowedNow(wanted: number): Promise<number> {
    let allowed = wanted;
    if (limits.maxConcurrentRuns !== null) {
      const running = await countRunningRuns();
      allowed = Math.min(allowed, limits.maxConcurrentRuns - running);
    }
    if (limits.maxStartsPerMinute !== null) {
      allowed = Math.min(allowed, limits.maxStartsPerMinute - startsInWindow(now()));
    }
    if (limits.minFreeMemoryMb !== null && allowed > 0) {
      const free = await freeMemoryBytes();
      // Unknown free memory (no cgroup limit) leaves the other limits in charge.
      if (free !== null) {
        const spare = free - limits.minFreeMemoryMb * MB;
        allowed = Math.min(allowed, Math.floor(spare / (limits.runMemoryEstimateMb * MB)));
      }
    }
    return Math.max(0, allowed);
  }

  return {
    async admit(wanted, claim) {
      if (wanted <= 0) return 0;
      if (!hasAnyLimit(limits)) {
        return claim(wanted);
      }
      // Serialize count-and-claim across agents: the per-agent start lock does
      // not stop two agents from both seeing the last free slot.
      const run = tail.then(async () => {
        const allowed = await allowedNow(wanted);
        if (allowed <= 0) return 0;
        const started = await claim(allowed);
        const at = now();
        for (let i = 0; i < started; i += 1) starts.push(at);
        return started;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

let shared: RunAdmission | null = null;

/**
 * One admission per server process: heartbeatService is instantiated by many
 * routes and services, and the lock and the start window must be shared by all
 * of them. The first caller's counter wins; every caller counts the same table.
 */
export function sharedRunAdmission(countRunningRuns: () => Promise<number>): RunAdmission {
  if (!shared) shared = createRunAdmission({ limits: readRunAdmissionLimits(), countRunningRuns });
  return shared;
}

/** Test hook: drop the process-wide admission so the next call rereads the env. */
export function resetSharedRunAdmissionForTests(): void {
  shared = null;
}
