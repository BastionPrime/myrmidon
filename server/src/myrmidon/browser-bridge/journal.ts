// myrmidon(EXTCASE-B): the browser bridge writes every action to the company journal.
//
// Design note §4.4 fixes the shape of a row: who (run, agent), when, what
// (action, url, target), the result, and the confirmation status. One rule is
// absolute: the page's content never reaches the journal. `browser.read` returns
// the page text to the bot, and `browser.screenshot` returns an image; the
// journal keeps their size (and the screenshot's workspace reference) and no
// byte of the payload. `summarizeActionResult` is the single place that decides
// what "the result" means per method, so a new method cannot leak by accident.

import type { BrowserBridgeMethod } from "@paperclipai/shared";

export const BROWSER_BRIDGE_ENTITY_TYPE = "browser_bridge";

export const BROWSER_BRIDGE_ACTIONS = {
  pairingCreated: "browser_bridge.pairing.created",
  pairingRejected: "browser_bridge.pairing.rejected",
  devicePaired: "browser_bridge.device.paired",
  deviceRevoked: "browser_bridge.device.revoked",
  connectionOpened: "browser_bridge.connection.opened",
  connectionClosed: "browser_bridge.connection.closed",
  actionExecuted: "browser_bridge.action.executed",
  actionDenied: "browser_bridge.action.denied",
  actionTimedOut: "browser_bridge.action.timed_out",
  allowlistUpdated: "browser_bridge.allowlist.updated",
} as const;

export type BrowserBridgeAction = (typeof BROWSER_BRIDGE_ACTIONS)[keyof typeof BROWSER_BRIDGE_ACTIONS];

export interface BrowserBridgeActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type BridgeConfirmationStatus = "not_required" | "confirmed" | "not_confirmed";
export type BridgeActionOutcome = "ok" | "denied" | "timeout" | "error";

export interface BrowserBridgeJournalEntry extends BrowserBridgeActor {
  companyId: string;
  action: BrowserBridgeAction;
  entityType: typeof BROWSER_BRIDGE_ENTITY_TYPE;
  entityId: string;
  details: Record<string, unknown>;
}

interface JournalBase extends BrowserBridgeActor {
  companyId: string;
  entityType: typeof BROWSER_BRIDGE_ENTITY_TYPE;
}

/**
 * Assemble the row from named fields only. Never spread the caller's input into
 * the entry: an action's `result` (page text, image) must not become a property
 * of the journal object by accident, and `logActivity` persists whatever it is
 * handed alongside `details`.
 */
function journalEntry(
  base: JournalBase,
  action: BrowserBridgeAction,
  entityId: string,
  details: Record<string, unknown>,
): BrowserBridgeJournalEntry {
  return {
    actorType: base.actorType,
    actorId: base.actorId,
    agentId: base.agentId,
    runId: base.runId,
    agentApiKeyId: base.agentApiKeyId,
    companyId: base.companyId,
    entityType: BROWSER_BRIDGE_ENTITY_TYPE,
    action,
    entityId,
    details,
  };
}

export function pairingCreatedEntry(
  base: JournalBase & { codeId: string; label: string | null; expiresAt: string },
): BrowserBridgeJournalEntry {
  return journalEntry(base, BROWSER_BRIDGE_ACTIONS.pairingCreated, base.codeId, {
    label: base.label,
    expiresAt: base.expiresAt,
  });
}

export function pairingRejectedEntry(
  base: JournalBase & { codeId: string; reason: "invalid" | "expired" | "consumed"; deviceId: string | null },
): BrowserBridgeJournalEntry {
  return journalEntry(base, BROWSER_BRIDGE_ACTIONS.pairingRejected, base.codeId, {
    reason: base.reason,
    deviceId: base.deviceId,
  });
}

export function devicePairedEntry(
  base: JournalBase & {
    deviceId: string;
    label: string | null;
    extVersion: string;
    capabilities: readonly string[];
    codeId: string;
  },
): BrowserBridgeJournalEntry {
  return journalEntry(base, BROWSER_BRIDGE_ACTIONS.devicePaired, base.deviceId, {
    label: base.label,
    extVersion: base.extVersion,
    capabilities: [...base.capabilities],
    pairingCodeId: base.codeId,
  });
}

export function deviceRevokedEntry(base: JournalBase & { deviceId: string }): BrowserBridgeJournalEntry {
  return journalEntry(base, BROWSER_BRIDGE_ACTIONS.deviceRevoked, base.deviceId, {});
}

export function allowlistUpdatedEntry(
  base: JournalBase & { domains: readonly string[] },
): BrowserBridgeJournalEntry {
  return journalEntry(base, BROWSER_BRIDGE_ACTIONS.allowlistUpdated, "allowlist", {
    domains: [...base.domains],
  });
}

export function connectionEntry(
  base: JournalBase & {
    deviceId: string;
    opened: boolean;
    extVersion: string;
    reason?: string;
  },
): BrowserBridgeJournalEntry {
  return journalEntry(
    base,
    base.opened ? BROWSER_BRIDGE_ACTIONS.connectionOpened : BROWSER_BRIDGE_ACTIONS.connectionClosed,
    base.deviceId,
    { extVersion: base.extVersion, ...(base.reason ? { reason: base.reason } : {}) },
  );
}

export interface ActionJournalInput extends JournalBase {
  deviceId: string;
  method: BrowserBridgeMethod;
  url: string | null;
  target: string | null;
  outcome: BridgeActionOutcome;
  confirmation: BridgeConfirmationStatus;
  durationMs: number;
  reasonCode: number | null;
  result: unknown;
}

export function actionEntry(input: ActionJournalInput): BrowserBridgeJournalEntry {
  const action =
    input.outcome === "ok"
      ? BROWSER_BRIDGE_ACTIONS.actionExecuted
      : input.outcome === "timeout"
        ? BROWSER_BRIDGE_ACTIONS.actionTimedOut
        : BROWSER_BRIDGE_ACTIONS.actionDenied;
  return journalEntry(input, action, input.deviceId, {
    method: input.method,
    url: input.url,
    target: input.target,
    outcome: input.outcome,
    confirmation: input.confirmation,
    durationMs: input.durationMs,
    ...(input.reasonCode === null ? {} : { reasonCode: input.reasonCode }),
    // Only the summary crosses into the journal; `input.result` stays out.
    result: summarizeActionResult(input.method, input.result),
  });
}

/**
 * What the journal is allowed to say about a result. Text and images stay out:
 * the journal keeps sizes, counts and workspace references only.
 */
export function summarizeActionResult(method: BrowserBridgeMethod, result: unknown): Record<string, unknown> {
  if (method === "browser.read") {
    const text = typeof result === "object" && result !== null ? (result as { text?: unknown }).text : undefined;
    return { textLength: typeof text === "string" ? text.length : 0 };
  }
  if (method === "browser.screenshot") {
    const payload = (result ?? {}) as { bytes?: unknown; workspacePath?: unknown };
    const bytes = typeof payload.bytes === "number" ? payload.bytes : 0;
    return {
      bytes,
      ...(typeof payload.workspacePath === "string" ? { workspacePath: payload.workspacePath } : {}),
    };
  }
  if (method === "browser.download") {
    const payload = (result ?? {}) as { bytes?: unknown; workspacePath?: unknown };
    return {
      bytes: typeof payload.bytes === "number" ? payload.bytes : 0,
      ...(typeof payload.workspacePath === "string" ? { workspacePath: payload.workspacePath } : {}),
    };
  }
  return {};
}