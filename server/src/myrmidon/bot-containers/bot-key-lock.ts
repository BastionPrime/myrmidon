// server/src/myrmidon/bot-containers/bot-key-lock.ts
//
// Per-bot serialization for everything that reconciles a bot's container: the
// periodic sweep and the single-agent "apply now" call (index.ts) both go through
// `withBotKeyLock`, so two reconciles of the same bot never overlap — they would
// otherwise race each other's helper container, marker and maintenance window.
// Different bots still run concurrently. In-process only: the board is the single
// writer of bot containers for now (a separate fleetd would own this itself).

export interface BotKeyLock {
  /** Runs `fn` once every earlier call for the same `botKey` has settled. A
   *  rejection is passed to this call's caller and never blocks later calls. */
  run<T>(botKey: string, fn: () => Promise<T>): Promise<T>;
  /** Number of bot keys with a call queued or running (for tests/diagnostics). */
  size(): number;
}

export function createBotKeyLock(): BotKeyLock {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(botKey: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(botKey) ?? Promise.resolve();
      const result = previous.then(fn);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(botKey, tail);
      void tail.then(() => {
        if (tails.get(botKey) === tail) tails.delete(botKey);
      });
      return result;
    },
    size() {
      return tails.size;
    },
  };
}

/** The process-wide lock shared by the sweep and "apply now". */
export const botKeyLock: BotKeyLock = createBotKeyLock();
