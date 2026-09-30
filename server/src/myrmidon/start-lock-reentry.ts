import { AsyncLocalStorage } from "node:async_hooks";

/**
 * myrmidon(START-LOCK-REENTRY): the agent start lock is keyed by agent id and
 * held for the whole body of a queued-run start. Part of that body runs work
 * that starts the next queued run for the *same* agent again: a start that
 * finds the agent not invokable cancels its active runs, and finishing a
 * cancellation promotes the next queued run. The nested start then read the
 * outer start's marker as its "previous" one and waited for a marker that can
 * only settle after the nested call returns, so the wait always lasted until
 * AGENT_START_LOCK_STALE_MS (30 s) and then continued with a stale warning.
 *
 * The chain below tells a start whether the lock it is about to wait for is
 * held by the very async chain it runs in. Such a wait can never make progress,
 * so it is skipped; a start from another chain (a genuinely concurrent one)
 * still waits exactly as before.
 *
 * Only the frames of the current chain are carried, and a frame is released
 * when its body settles: a detached execution that was started inside the body
 * but outlives it must wait like any other chain.
 */

type StartLockFrame = { readonly agentId: string; released: boolean };

const startLockChain = new AsyncLocalStorage<readonly StartLockFrame[]>();

/**
 * Runs `fn` as the holder of the start lock for `agentId` inside the current
 * async chain. Every descendant created by `fn` sees the frame, but only while
 * the body runs; the frame is released when the body settles.
 */
export function runAsStartLockHolder<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const frame: StartLockFrame = { agentId, released: false };
  const chain = [...(startLockChain.getStore() ?? []), frame];
  return startLockChain.run(chain, async () => {
    try {
      return await fn();
    } finally {
      frame.released = true;
    }
  });
}

/** True while the current async chain is inside a live start-lock body for `agentId`. */
export function isStartLockHeldInCurrentChain(agentId: string): boolean {
  const chain = startLockChain.getStore();
  if (!chain) return false;
  return chain.some((frame) => frame.agentId === agentId && !frame.released);
}