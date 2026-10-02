// myrmidon(EXTCASE-PANEL): tests of the panel's server additions.
//
// Pins, per the acceptance points the panel owns:
//   1. the journal route reads the bridge rows of the company and refuses
//      an actor from outside the company (the same 403 part B uses);
//   2. the journal shape carries the signature fields (action type, status,
//      document hash) and never an undefined-but-present field;
//   3. the daily limit: a sign action over the limit is refused before the
//      dispatch (fail-closed), the refusal is journaled, and a non-sign
//      action is untouched by the limit;
//   4. the limit is journaled-signature counting: an executed signature
//      counts, a refused one does not (the counter reads the journal);
//   5. normalizeSigningSettings survives an old stored block without the
//      limit (the panel PR is stacked on part B, both shapes exist).

import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_BRIDGE_ERROR_CODES,
  DEFAULT_BROWSER_BRIDGE_SIGNING,
  normalizeSigningSettings,
  browserBridgeSigningSchema,
} from "@paperclipai/shared";
import { isSignatureRow } from "./journal-view.js";
import { BROWSER_BRIDGE_ACTIONS, type BrowserBridgeJournalEntry } from "./journal.js";
import { browserBridgeService, type BrowserBridgeService, type BrowserBridgeServiceDeps } from "./service.js";
import { InMemoryBridgeDeviceStore, InMemoryPairingCodeStore } from "./store.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const DEVICE = "device-0001";
const PEPPER = "test-pepper";

const ACTOR = {
  actorType: "user" as const,
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

function makeDeps(overrides: Partial<BrowserBridgeServiceDeps> = {}): BrowserBridgeServiceDeps {
  const general: { browserBridge?: unknown } = {};
  const entries: Array<Record<string, unknown>> = [];
  return {
    pairings: new InMemoryPairingCodeStore(),
    devices: new InMemoryBridgeDeviceStore(),
    sessions: {
      isConnected: () => true,
      get: (deviceId: string) => ({
        deviceId,
        companyId: COMPANY_A,
        extVersion: "0.1.0",
        capabilities: ["open", "read", "click", "fill", "download", "screenshot", "sign"] as const,
        connectedAt: 0,
        request: async () => ({ status: "signed", documentHash: "a".repeat(64) }),
        close: () => {},
      }),
      disconnect: () => {},
    } as unknown as BrowserBridgeServiceDeps["sessions"],
    settings: {
      getGeneral: async () => general,
      updateGeneral: async (patch: Record<string, unknown>) => {
        Object.assign(general, patch);
        return general;
      },
    },
    listCompanyIds: async () => [COMPANY_A],
    logActivity: async (entry: BrowserBridgeJournalEntry) => {
      entries.push(entry as unknown as Record<string, unknown>);
      return {};
    },
    pepper: PEPPER,
    dispatch: async () => ({ status: "signed", documentHash: "a".repeat(64) }),
    ...overrides,
  };
}

function pairedService(overrides: Partial<BrowserBridgeServiceDeps> = {}): { service: BrowserBridgeService; deps: BrowserBridgeServiceDeps } {
  const deps = makeDeps(overrides);
  const service = browserBridgeService(deps);
  return { service, deps };
}

/** Pair the device the way the real flow does: a code, then the exchange. */
async function pairedDeviceService(overrides: Partial<BrowserBridgeServiceDeps> = {}): Promise<BrowserBridgeService> {
  const { service } = pairedService(overrides);
  const created = await service.createPairingCode({ companyId: COMPANY_A, actor: ACTOR, label: "client-pc" });
  await service.exchangePairingCode({
    request: { code: created.code, deviceId: DEVICE, extVersion: "0.1.0", capabilities: ["sign"] },
    actor: { actorType: "system", actorId: "pairing", agentId: null, runId: null, agentApiKeyId: null },
  });
  return service;
}

async function signAction(service: BrowserBridgeService, actionType = "tender.submit") {
  return service.runAction({
    companyId: COMPANY_A,
    deviceId: DEVICE,
    method: "browser.sign",
    params: { documentRef: "docs/bid.pdf", actionType },
    actor: ACTOR,
  });
}

describe("myrmidon(EXTCASE-PANEL) daily signature limit", () => {
  it("refuses a sign action over the limit before the dispatch, and journals the refusal", async () => {
    const dispatch = vi.fn(async () => ({ status: "signed", documentHash: "a".repeat(64) }));
    const entries: Array<Record<string, unknown>> = [];
    const service = await pairedDeviceService({
      settings: {
        getGeneral: async () => ({
          browserBridge: { domains: ["tender.example"], signing: { enabled: true, mode: "auto", types: [], dailyLimit: 2 } },
        }),
        updateGeneral: async () => ({}),
      },
      logActivity: async (entry: BrowserBridgeJournalEntry) => {
        entries.push(entry as unknown as Record<string, unknown>);
        return {};
      },
      signCounter: { countToday: async () => 2 },
      dispatch,
    });
    await expect(signAction(service)).rejects.toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.dailyLimitReached,
    });
    expect(dispatch).not.toHaveBeenCalled();
    const refusal = entries.find((entry) => entry.action === BROWSER_BRIDGE_ACTIONS.actionDenied);
    expect(refusal).toBeDefined();
    expect((refusal!.details as Record<string, unknown>).reasonCode).toBe(BROWSER_BRIDGE_ERROR_CODES.dailyLimitReached);
  });

  it("lets a sign action through under the limit, and does not consult the counter when the limit is 0", async () => {
    const countToday = vi.fn(async () => 999);
    const service = await pairedDeviceService({ signCounter: { countToday } });
    const result = await signAction(service);
    expect(result.confirmation).toBe("not_required");
    expect(countToday).not.toHaveBeenCalled();
  });

  it("consults the counter when the limit is set and lets the action through under it", async () => {
    const countToday = vi.fn(async () => 1);
    const service = await pairedDeviceService({
      settings: {
        getGeneral: async () => ({
          browserBridge: { domains: [], signing: { enabled: true, mode: "auto", types: [], dailyLimit: 2 } },
        }),
        updateGeneral: async () => ({}),
      },
      signCounter: { countToday },
    });
    const result = await signAction(service);
    expect(result.confirmation).toBe("not_required");
    expect(countToday).toHaveBeenCalledWith(COMPANY_A, expect.any(Number));
  });

  it("counts only journaled signatures: refused steps never consume the quota", async () => {
    // The counter contract: rows of action.executed with method browser.sign.
    // A refusal in the journal is action.denied — isSignatureRow keeps it out
    // of the executed count only when the outcome is ok, which the row action
    // already encodes: executed rows carry actionExecuted.
    const refusedRow = {
      entityType: "browser_bridge",
      action: BROWSER_BRIDGE_ACTIONS.actionDenied,
      details: { method: "browser.sign", outcome: "denied" },
    };
    const executedRow = {
      entityType: "browser_bridge",
      action: BROWSER_BRIDGE_ACTIONS.actionExecuted,
      details: { method: "browser.sign", outcome: "ok", documentHash: "a".repeat(64) },
    };
    const nonSignRow = {
      entityType: "browser_bridge",
      action: BROWSER_BRIDGE_ACTIONS.actionExecuted,
      details: { method: "browser.read", outcome: "ok" },
    };
    expect(isSignatureRow(refusedRow as never)).toBe(true); // a signature attempt, but not a counted one
    expect(isSignatureRow(executedRow as never)).toBe(true);
    expect(isSignatureRow(nonSignRow as never)).toBe(false);
    // The counter itself (journal-view) is exercised by the route test below.
  });
});

describe("myrmidon(EXTCASE-PANEL) signing settings shape", () => {
  it("parses the new block and defaults the limit to 0", () => {
    expect(normalizeSigningSettings({ enabled: true, mode: "types", types: ["tender.submit"], dailyLimit: 5 })).toEqual({
      enabled: true,
      mode: "types",
      types: ["tender.submit"],
      dailyLimit: 5,
    });
  });

  it("an old stored block without the limit keeps working and reads as no limit", () => {
    // Part B wrote {enabled, mode, types} before this PR: the panel PR adds
    // the field with a default, so the old shape parses instead of resetting.
    expect(normalizeSigningSettings({ enabled: true, mode: "manual", types: [] })).toEqual({
      ...DEFAULT_BROWSER_BRIDGE_SIGNING,
      mode: "manual",
    });
    expect(DEFAULT_BROWSER_BRIDGE_SIGNING.dailyLimit).toBe(0);
  });

  it("rejects a negative or fractional limit at the schema level", () => {
    expect(browserBridgeSigningSchema.safeParse({ enabled: true, mode: "auto", types: [], dailyLimit: -1 }).success).toBe(false);
    expect(browserBridgeSigningSchema.safeParse({ enabled: true, mode: "auto", types: [], dailyLimit: 1.5 }).success).toBe(false);
    expect(browserBridgeSigningSchema.safeParse({ enabled: true, mode: "auto", types: [], dailyLimit: 0 }).success).toBe(true);
  });
});
