import { logger } from "../middleware/logger.js";
// myrmidon(START-LOCK-REENTRY): the lock must not wait on itself when a start
// re-enters it for the agent whose start this async chain already runs.
import {
  isStartLockHeldInCurrentChain,
  runAsStartLockHolder,
} from "../myrmidon/start-lock-reentry.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  // myrmidon(START-LOCK-REENTRY): a start that re-enters the lock for the agent
  // whose start this async chain already runs cannot make progress by waiting
  // for its own marker -- that marker settles only after this call returns --
  // so it would stall until AGENT_START_LOCK_STALE_MS and warn. Run it now; a
  // start from another chain still waits below.
  if (isStartLockHeldInCurrentChain(agentId)) {
    logger.debug(
      { agentId },
      "agent start lock re-entry; continuing queued-run start without waiting",
    );
    return fn();
  }

  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const run = waitForPrevious.then(() => runAsStartLockHolder(agentId, fn));
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}
