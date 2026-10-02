// The confirmation primitive's bookkeeping: who is waiting for a person, and
// what the person (or the gateway's cancellation) answered.
//
// Kept apart from the Chrome prompt on purpose. The registry is pure state — a
// promise per pending request id — so the protocol behaviour is exercised
// without a window, and the entry point supplies the rendering. The key is the
// gateway's request id, because that is also the id the gateway names in its
// `browser.cancel` notification when the 180 s budget expires.

import type { ConfirmationDecision, ConfirmationPort, ConfirmationPrompt } from "./actions";

export interface ConfirmationRegistry {
  /** Register a prompt; resolves when the person or a cancellation answers. */
  request(prompt: ConfirmationPrompt): Promise<ConfirmationDecision>;
  /** The person answered in the UI (confirm window). */
  settle(key: string | number, decision: ConfirmationDecision): boolean;
  /** The gateway gave up on a request: its prompt is dropped as refused. */
  cancel(requestId: string | number): boolean;
  pendingCount(): number;
  pendingKeys(): (string | number)[];
}

export function createConfirmationRegistry(): ConfirmationRegistry {
  const pending = new Map<string | number, (decision: ConfirmationDecision) => void>();
  let localSeq = 0;

  const settle = (key: string | number, decision: ConfirmationDecision): boolean => {
    const resolve = pending.get(key);
    if (!resolve) return false;
    pending.delete(key);
    resolve(decision);
    return true;
  };

  return {
    request(prompt) {
      const key = prompt.requestId ?? `local-${(localSeq += 1)}`;
      return new Promise<ConfirmationDecision>((resolve) => {
        pending.set(key, resolve);
      });
    },
    settle,
    cancel(requestId) {
      return settle(requestId, "refused");
    },
    pendingCount() {
      return pending.size;
    },
    pendingKeys() {
      return [...pending.keys()];
    },
  };
}

/** The person-facing half of the primitive, as the entry point supplies it. */
export interface ConfirmationUi {
  /** Show the prompt (a window that asks "confirm?"). */
  open(prompt: ConfirmationPrompt): void;
  /** The request is over: close its window if it is still open. */
  close(requestId: string | number): void;
}

/**
 * The port the action dispatcher sees: it asks the person and waits, while the
 * gateway's cancellation closes the prompt and answers the wait as a refusal.
 */
export function createConfirmationPort(registry: ConfirmationRegistry, ui: ConfirmationUi): ConfirmationPort {
  return {
    request(prompt) {
      const answer = registry.request(prompt);
      ui.open(prompt);
      return answer;
    },
    cancel(requestId) {
      ui.close(requestId);
      registry.cancel(requestId);
    },
  };
}