// myrmidon(EXTCASE-B): browser-bridge gateway tests.
//
// Everything here runs against the service with injected ports: no socket, no
// database, no secret provider. The fixtures are neutral (example.test domains,
// fixed ids) so nothing from a real deployment leaks into the suite.
//
// The suite pins the four gates the design note puts on the bridge:
//   1. pairing is one-shot, 15 minutes, and the device gets its own token;
//   2. a device is only reachable through the capability set it declared;
//   3. a url outside the allowlist is refused by the gateway, not only by the
//      extension (defense in depth);
//   4. a signing step waits for the person (180 s) and a give-up is journaled as
//      a timeout — while the page's own content never reaches the journal.

import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_BRIDGE_ERROR_CODES,
  BRIDGE_ACTION_TIMEOUT_MS,
  BRIDGE_CONFIRMATION_TIMEOUT_MS,
  PAIRING_CODE_PATTERN,
  PAIRING_CODE_TTL_MS,
  isUrlAllowedByAllowlist,
  normalizeAllowlistDomains,
  normalizeCapabilitySet,
  normalizePairingCode,
  validateActionParams,
} from "@paperclipai/shared";
import {
  IdempotencyCache,
  jsonRpcError,
  jsonRpcSuccess,
  parseJsonRpcRequest,
  parseJsonRpcResponse,
} from "./jsonrpc.js";
import { summarizeActionResult, type BrowserBridgeJournalEntry } from "./journal.js";
import { InMemoryBridgeSessionRegistry, type BridgeSession } from "./sessions.js";
import { BrowserBridgeError, browserBridgeService, type BrowserBridgeService, type BrowserBridgeServiceDeps } from "./service.js";
import { InMemoryBridgeDeviceStore, InMemoryPairingCodeStore } from "./store.js";
import { generatePairingCode, parseBridgeToken } from "./tokens.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const DEVICE = "device-0001";
const PEPPER = "test-pepper";

const USER_ACTOR = {
  actorType: "user" as const,
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

const AGENT_ACTOR = {
  actorType: "agent" as const,
  actorId: "agent-1",
  agentId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  agentApiKeyId: "key-1",
};

class FakeSession implements BridgeSession {
  readonly capabilities;
  readonly extVersion = "0.1.0";
  readonly connectedAt = 0;
  closed = 0;
  readonly requests: Array<{ method: string; timeoutMs: number }> = [];

  constructor(
    readonly deviceId: string,
    readonly companyId: string,
    capabilities: BridgeSession["capabilities"],
    private readonly behavior: (method: string, params: unknown) => Promise<unknown>,
  ) {
    this.capabilities = capabilities;
  }

  async request(method: Parameters<BridgeSession["request"]>[0], params: unknown, timeoutMs: number) {
    this.requests.push({ method, timeoutMs });
    return this.behavior(method, params);
  }

  close(): void {
    this.closed += 1;
  }
}

function harness(options: {
  allowlist?: string[];
  signing?: { enabled: boolean; mode: string; types: string[] };
  behavior?: (method: string, params: unknown) => Promise<unknown>;
  now?: () => number;
} = {}) {
  const journal: BrowserBridgeJournalEntry[] = [];
  const settings = {
    general: {
      browserBridge: {
        domains: options.allowlist ?? [],
        ...(options.signing ? { signing: options.signing } : {}),
      },
    } as { browserBridge?: unknown },
    getGeneral: vi.fn(async () => settings.general),
    updateGeneral: vi.fn(async (patch: { browserBridge: unknown }) => {
      settings.general = patch;
      return patch;
    }),
  };
  const session = new FakeSession(
    DEVICE,
    COMPANY_A,
    ["open", "read", "click", "screenshot", "sign"],
    options.behavior ?? (async () => ({ ok: true })),
  );
  const sessions = new InMemoryBridgeSessionRegistry();
  sessions.register(session);

  const deps: BrowserBridgeServiceDeps = {
    pairings: new InMemoryPairingCodeStore(),
    devices: new InMemoryBridgeDeviceStore(),
    sessions,
    settings,
    listCompanyIds: async () => [COMPANY_A],
    logActivity: async (entry) => {
      journal.push(entry);
      return entry;
    },
    pepper: PEPPER,
    ...(options.now ? { now: options.now } : {}),
    dispatch: async (input) => session.request(input.method, input.params, input.timeoutMs),
  };
  const service = browserBridgeService(deps);
  return { service, journal, session, sessions, settings, deps };
}

async function pair(service: BrowserBridgeService, companyId = COMPANY_A) {
  const created = await service.createPairingCode({ companyId, actor: USER_ACTOR, label: "client-pc" });
  const paired = await service.exchangePairingCode({
    request: { code: created.code, deviceId: DEVICE, extVersion: "0.1.0", capabilities: ["open", "read", "click", "screenshot", "sign"] },
    actor: { actorType: "system", actorId: "pairing", agentId: null, runId: null, agentApiKeyId: null },
  });
  return { created, paired };
}

describe("browser bridge: json-rpc framing", () => {
  it("answers a non-JSON frame with a parse error and no id", () => {
    const parsed = parseJsonRpcRequest("{ not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.response.error.code).toBe(BROWSER_BRIDGE_ERROR_CODES.parseError);
    expect(parsed.response.id).toBeNull();
  });

  it("answers a JSON frame without a usable request shape with invalid request, echoing the id", () => {
    const parsed = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.response.error.code).toBe(BROWSER_BRIDGE_ERROR_CODES.invalidRequest);
    expect(parsed.response.id).toBe(7);
  });

  it("accepts a string id and keeps params optional", () => {
    const parsed = parseJsonRpcRequest(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "browser.read" }));
    expect(parsed).toEqual({ ok: true, request: { jsonrpc: "2.0", id: "a", method: "browser.read" } });
  });

  it("reads a success and an error answer from the extension", () => {
    expect(parseJsonRpcResponse(JSON.stringify(jsonRpcSuccess(1, { text: "hi" })))).toEqual({
      ok: true,
      id: 1,
      result: { text: "hi" },
    });
    const failure = parseJsonRpcResponse(JSON.stringify(jsonRpcError(2, -32013, "not allowed")));
    expect(failure && failure.ok === false && failure.error?.code).toBe(-32013);
    expect(parseJsonRpcResponse("garbage")).toBeNull();
  });
});

describe("browser bridge: idempotency cache", () => {
  it("replays a stored answer inside the window and drops it after", () => {
    let now = 1_000;
    const cache = new IdempotencyCache({ limit: 2, ttlMs: 100, now: () => now });
    const frame = jsonRpcSuccess("replay", { value: 1 });
    cache.set("k", frame);
    expect(cache.get("k")).toBe(frame);
    now += 101;
    expect(cache.get("k")).toBeUndefined();
  });

  it("keeps the newest entries when the limit is exceeded", () => {
    const cache = new IdempotencyCache({ limit: 2, now: () => 0 });
    cache.set("a", jsonRpcSuccess("replay", 1));
    cache.set("b", jsonRpcSuccess("replay", 2));
    cache.set("c", jsonRpcSuccess("replay", 3));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });
});

describe("browser bridge: pairing", () => {
  it("issues a human-readable, one-shot code with a 15 minute life", async () => {
    const { service, journal } = harness();
    const created = await service.createPairingCode({ companyId: COMPANY_A, actor: USER_ACTOR, label: "client-pc" });
    expect(created.code).toMatch(PAIRING_CODE_PATTERN);
    const lifeMs = Date.parse(created.expiresAt) - Date.now();
    expect(lifeMs).toBeGreaterThan(PAIRING_CODE_TTL_MS - 5_000);
    expect(lifeMs).toBeLessThanOrEqual(PAIRING_CODE_TTL_MS);
    expect(journal.map((entry) => entry.action)).toEqual(["browser_bridge.pairing.created"]);
    expect(journal[0]?.details).toMatchObject({ label: "client-pc" });
  });

  it("normalizes the code as a person types it", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizePairingCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizePairingCode("ABCD-EFG")).toBeNull();
    expect(normalizePairingCode("ABCD-EFOI")).toBeNull(); // confusable letters are not in the alphabet
  });

  it("exchanges the code once and binds the token to the device and company", async () => {
    const { service, journal } = harness();
    const { created, paired } = await pair(service);
    expect(created.code).toBeTruthy();
    expect(paired.deviceId).toBe(DEVICE);
    expect(paired.capabilities).toEqual(["open", "read", "click", "screenshot", "sign"]);
    const parts = parseBridgeToken(paired.token);
    expect(parts?.companyId).toBe(COMPANY_A);
    expect(parts?.deviceId).toBe(DEVICE);

    expect(journal.map((entry) => entry.action)).toEqual([
      "browser_bridge.pairing.created",
      "browser_bridge.device.paired",
    ]);
  });

  it("refuses the same code a second time (one-shot)", async () => {
    const { service, journal } = harness();
    const { created } = await pair(service);
    await expect(
      service.exchangePairingCode({
        request: { code: created.code, deviceId: "device-0002", extVersion: "0.1.0" },
        actor: { actorType: "system", actorId: "pairing", agentId: null, runId: null, agentApiKeyId: null },
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.pairingCodeInvalid });
    expect(journal.some((entry) => entry.action === "browser_bridge.pairing.rejected")).toBe(true);
  });

  it("refuses an expired code", async () => {
    let now = 1_000;
    const { service } = harness({ now: () => now });
    const created = await service.createPairingCode({ companyId: COMPANY_A, actor: USER_ACTOR });
    now += PAIRING_CODE_TTL_MS + 1;
    await expect(
      service.exchangePairingCode({
        request: { code: created.code, deviceId: DEVICE, extVersion: "0.1.0" },
        actor: { actorType: "system", actorId: "pairing", agentId: null, runId: null, agentApiKeyId: null },
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.pairingCodeExpired });
  });

  it("refuses an unknown code without writing an unattributable journal row", async () => {
    const { service, journal } = harness();
    await expect(
      service.exchangePairingCode({
        request: { code: "ZZZZ-ZZZZ", deviceId: DEVICE, extVersion: "0.1.0" },
        actor: { actorType: "system", actorId: "pairing", agentId: null, runId: null, agentApiKeyId: null },
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.pairingCodeInvalid });
    expect(journal).toHaveLength(0);
  });
});

describe("browser bridge: device authentication and revocation", () => {
  it("accepts the issued token and refuses a different one", async () => {
    const { service } = harness();
    const { paired } = await pair(service);
    await expect(
      service.authenticateDevice({ companyId: COMPANY_A, deviceId: DEVICE, token: paired.token }),
    ).resolves.toMatchObject({ deviceId: DEVICE });
    await expect(
      service.authenticateDevice({ companyId: COMPANY_A, deviceId: DEVICE, token: "mbb_a.b.c" }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.revoked });
  });

  it("refuses a token of another company for the same device id", async () => {
    const { service } = harness();
    const { paired } = await pair(service, COMPANY_A);
    await expect(
      service.authenticateDevice({ companyId: COMPANY_B, deviceId: DEVICE, token: paired.token }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.notPaired });
  });

  it("revokes fail-closed: the record goes and the live socket is dropped", async () => {
    const { service, journal, session, sessions } = harness();
    const { paired } = await pair(service);
    expect(sessions.isConnected(DEVICE)).toBe(true);

    const result = await service.revokeDevice({ companyId: COMPANY_A, deviceId: DEVICE, actor: USER_ACTOR });
    expect(result.revoked).toBe(true);
    expect(session.closed).toBe(1);
    expect(sessions.isConnected(DEVICE)).toBe(false);
    expect(journal.map((entry) => entry.action)).toContain("browser_bridge.device.revoked");

    await expect(
      service.authenticateDevice({ companyId: COMPANY_A, deviceId: DEVICE, token: paired.token }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.notPaired });
  });
});

describe("browser bridge: capabilities and allowlist gates", () => {
  it("needs the declared capability and journals the refusal", async () => {
    const { service, journal } = harness();
    await pair(service);
    // The fake session declared open/read/click/screenshot but not fill.
    await expect(
      service.runAction({
        companyId: COMPANY_A,
        deviceId: DEVICE,
        method: "browser.fill",
        params: { target: "#pin", value: "0000" },
        actor: AGENT_ACTOR,
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.capabilityUnsupported });
    const denied = journal.at(-1);
    expect(denied?.action).toBe("browser_bridge.action.denied");
    expect(denied?.details).toMatchObject({ outcome: "denied", reasonCode: BROWSER_BRIDGE_ERROR_CODES.capabilityUnsupported });
  });

  it("refuses a url outside the allowlist even when the extension declared the capability", async () => {
    const { service, journal } = harness({ allowlist: ["tender.example"] });
    await pair(service);
    await expect(
      service.runAction({
        companyId: COMPANY_A,
        deviceId: DEVICE,
        method: "browser.open",
        params: { url: "https://evil.test/steal" },
        actor: AGENT_ACTOR,
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed });
    expect(journal.at(-1)?.action).toBe("browser_bridge.action.denied");
  });

  it("allows the domain itself and its subdomains, and never a lookalike suffix", () => {
    const allowlist = normalizeAllowlistDomains(["tender.example"]);
    expect(isUrlAllowedByAllowlist("https://tender.example/bid", allowlist)).toBe(true);
    expect(isUrlAllowedByAllowlist("https://www.tender.example/bid", allowlist)).toBe(true);
    expect(isUrlAllowedByAllowlist("https://tender.example.evil.test/", allowlist)).toBe(false);
    expect(isUrlAllowedByAllowlist("ftp://tender.example/", allowlist)).toBe(false);
    expect(isUrlAllowedByAllowlist("not a url", allowlist)).toBe(false);
    expect(normalizeAllowlistDomains(["https://tender.example/x", "*", "ok.example"])).toEqual(["ok.example"]);
  });

  it("is deny-by-default with an empty allowlist", async () => {
    const { service } = harness({ allowlist: [] });
    await pair(service);
    await expect(
      service.runAction({
        companyId: COMPANY_A,
        deviceId: DEVICE,
        method: "browser.open",
        params: { url: "https://tender.example/" },
        actor: AGENT_ACTOR,
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed });
  });

  it("validates the method's required parameters", () => {
    expect(validateActionParams("browser.open", {}).ok).toBe(false);
    expect(validateActionParams("browser.open", { url: "/relative" }).ok).toBe(false);
    expect(validateActionParams("browser.fill", { target: "#x" }).ok).toBe(false);
    expect(validateActionParams("browser.fill", { target: "#x", value: "1" }).ok).toBe(true);
    expect(validateActionParams("browser.read", {}).ok).toBe(true);
    expect(validateActionParams("browser.read", { url: "https://tender.example/" }).ok).toBe(true);
    expect(normalizeCapabilitySet(["read", "nope"])).toBeNull();
  });
});

describe("browser bridge: actions and journal", () => {
  it("runs an action on the 30 s budget and journals the outcome without the page", async () => {
    const { service, journal, session } = harness({
      allowlist: ["tender.example"],
      behavior: async () => ({ text: "секретный текст страницы", title: "ТП" }),
    });
    await pair(service);
    const result = await service.runAction({
      companyId: COMPANY_A,
      deviceId: DEVICE,
      method: "browser.read",
      params: {},
      actor: AGENT_ACTOR,
    });
    expect(session.requests.at(-1)?.timeoutMs).toBe(BRIDGE_ACTION_TIMEOUT_MS);
    expect(result.confirmation).toBe("not_required");
    expect(result.result).toEqual({ text: "секретный текст страницы", title: "ТП" });

    const executed = journal.at(-1);
    expect(executed?.action).toBe("browser_bridge.action.executed");
    expect(executed?.details).toMatchObject({
      method: "browser.read",
      outcome: "ok",
      confirmation: "not_required",
      result: { textLength: 24 },
    });
    expect(JSON.stringify(journal)).not.toContain("секретный текст");
    expect(executed?.agentId).toBe(AGENT_ACTOR.agentId);
    expect(executed?.runId).toBe(AGENT_ACTOR.runId);
  });

  it("holds a signing step for the 180 s confirmation budget", async () => {
    const { service, session } = harness({
      allowlist: ["tender.example"],
      behavior: async () => ({ submitted: true }),
    });
    await pair(service);
    const result = await service.runAction({
      companyId: COMPANY_A,
      deviceId: DEVICE,
      method: "browser.click",
      params: { target: "#submit", confirmation: "human" },
      actor: AGENT_ACTOR,
    });
    expect(session.requests.at(-1)?.timeoutMs).toBe(BRIDGE_CONFIRMATION_TIMEOUT_MS);
    expect(result.confirmation).toBe("confirmed");
  });

  it("journals a not-confirmed signing step as a timeout", async () => {
    const { service, journal } = harness({
      allowlist: ["tender.example"],
      behavior: async () => {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.timeout, "browser.click timed out", {
          timeoutMs: BRIDGE_CONFIRMATION_TIMEOUT_MS,
        });
      },
    });
    await pair(service);
    await expect(
      service.runAction({
        companyId: COMPANY_A,
        deviceId: DEVICE,
        method: "browser.click",
        params: { target: "#submit", confirmation: "human" },
        actor: AGENT_ACTOR,
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.timeout });
    expect(journal.at(-1)?.action).toBe("browser_bridge.action.timed_out");
    expect(journal.at(-1)?.details).toMatchObject({ outcome: "timeout", confirmation: "not_confirmed" });
  });

  it("fails fast for an offline device instead of waiting for the budget", async () => {
    const { service, sessions } = harness({ allowlist: ["tender.example"] });
    await pair(service);
    sessions.disconnect(DEVICE, "test");
    await expect(
      service.runAction({
        companyId: COMPANY_A,
        deviceId: DEVICE,
        method: "browser.read",
        params: {},
        actor: AGENT_ACTOR,
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.deviceOffline });
  });

  it("summarizes results by method and keeps images and text out of the journal", () => {
    expect(summarizeActionResult("browser.read", { text: "abcd" })).toEqual({ textLength: 4 });
    expect(summarizeActionResult("browser.screenshot", { bytes: 10, workspacePath: "shots/a.png" })).toEqual({
      bytes: 10,
      workspacePath: "shots/a.png",
    });
    expect(summarizeActionResult("browser.download", { bytes: 7 })).toEqual({ bytes: 7 });
    expect(summarizeActionResult("browser.click", { clicked: true })).toEqual({});
  });
});

describe("browser bridge: allowlist settings and sessions", () => {
  it("stores the normalized allowlist and journals it per company", async () => {
    const { service, journal, settings } = harness();
    const next = await service.updateSettings({
      patch: { domains: ["Tender.Example ", "tender.example"] },
      actor: USER_ACTOR,
    });
    expect(next.domains).toEqual(["tender.example"]);
    expect(settings.updateGeneral).toHaveBeenCalledWith({
      browserBridge: { domains: ["tender.example"], signing: { enabled: true, mode: "auto", types: [] } },
    });
    expect(journal.at(-1)?.action).toBe("browser_bridge.allowlist.updated");
    expect(journal.at(-1)?.companyId).toBe(COMPANY_A);
  });

  it("replaces a stale session for the same device", () => {
    const sessions = new InMemoryBridgeSessionRegistry();
    const first = new FakeSession(DEVICE, COMPANY_A, [], async () => null);
    const second = new FakeSession(DEVICE, COMPANY_A, [], async () => null);
    sessions.register(first);
    sessions.register(second);
    expect(first.closed).toBe(1);
    expect(sessions.get(DEVICE)).toBe(second);
    sessions.unregister(first);
    expect(sessions.get(DEVICE)).toBe(second);
    sessions.disconnect(DEVICE, "bye");
    expect(second.closed).toBe(1);
  });

  it("generates codes from the unambiguous alphabet only", () => {
    for (let i = 0; i < 25; i += 1) {
      expect(generatePairingCode()).toMatch(PAIRING_CODE_PATTERN);
    }
  });
});

describe("browser bridge: signing policy", () => {
  const DOCUMENT_HASH = "a".repeat(64);
  const SIGN_PARAMS = { documentRef: "workspace/tender/application.pdf", actionType: "application.submit" };
  const SIGNED = async () => ({ status: "signed", documentHash: DOCUMENT_HASH });

  async function runSign(
    harnessed: ReturnType<typeof harness>,
    params: Record<string, unknown> = SIGN_PARAMS,
  ) {
    await pair(harnessed.service);
    return harnessed.service.runAction({
      companyId: COMPANY_A,
      deviceId: DEVICE,
      method: "browser.sign",
      params,
      actor: AGENT_ACTOR,
    });
  }

  it("signs on the action budget by default and journals type and digest", async () => {
    const harnessed = harness({ behavior: SIGNED });
    const result = await runSign(harnessed);
    expect(harnessed.session.requests.at(-1)?.timeoutMs).toBe(BRIDGE_ACTION_TIMEOUT_MS);
    expect(result.confirmation).toBe("not_required");
    const executed = harnessed.journal.at(-1);
    expect(executed?.action).toBe("browser_bridge.action.executed");
    expect(executed?.details).toMatchObject({
      method: "browser.sign",
      signActionType: "application.submit",
      signStatus: "signed",
      documentHash: DOCUMENT_HASH,
      result: { signStatus: "signed" },
    });
    expect(executed?.details).not.toHaveProperty("documentRef");
  });

  it("waits for a person in manual mode", async () => {
    const harnessed = harness({ signing: { enabled: true, mode: "manual", types: [] }, behavior: SIGNED });
    const result = await runSign(harnessed);
    expect(harnessed.session.requests.at(-1)?.timeoutMs).toBe(BRIDGE_CONFIRMATION_TIMEOUT_MS);
    expect(result.confirmation).toBe("confirmed");
    expect(harnessed.journal.at(-1)?.details).toMatchObject({ confirmation: "confirmed" });
  });

  it("applies the per-type mode only to the listed action types", async () => {
    const listed = harness({
      signing: { enabled: true, mode: "types", types: ["application.submit"] },
      behavior: SIGNED,
    });
    await runSign(listed);
    expect(listed.session.requests.at(-1)?.timeoutMs).toBe(BRIDGE_CONFIRMATION_TIMEOUT_MS);

    const other = harness({
      signing: { enabled: true, mode: "types", types: ["application.submit"] },
      behavior: SIGNED,
    });
    await runSign(other, { documentRef: "workspace/tender/notice.pdf", actionType: "notice.acknowledge" });
    expect(other.session.requests.at(-1)?.timeoutMs).toBe(BRIDGE_ACTION_TIMEOUT_MS);
  });

  it("refuses every sign action when the emergency switch is off, without reaching the device", async () => {
    const harnessed = harness({ signing: { enabled: false, mode: "auto", types: [] }, behavior: SIGNED });
    await pair(harnessed.service);
    const before = harnessed.session.requests.length;
    await expect(
      harnessed.service.runAction({
        companyId: COMPANY_A,
        deviceId: DEVICE,
        method: "browser.sign",
        params: SIGN_PARAMS,
        actor: AGENT_ACTOR,
      }),
    ).rejects.toMatchObject({ reasonCode: BROWSER_BRIDGE_ERROR_CODES.signingDisabled });
    expect(harnessed.session.requests.length).toBe(before);
    expect(harnessed.journal.at(-1)?.action).toBe("browser_bridge.action.denied");
    expect(harnessed.journal.at(-1)?.details).toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.signingDisabled,
      signActionType: "application.submit",
    });
  });

  it("journals a refusal by the helper as a denial with the digest", async () => {
    const harnessed = harness({
      behavior: async () => ({ status: "refused", documentHash: DOCUMENT_HASH }),
    });
    await expect(runSign(harnessed)).rejects.toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.confirmationNotGranted,
    });
    expect(harnessed.journal.at(-1)?.action).toBe("browser_bridge.action.denied");
    expect(harnessed.journal.at(-1)?.details).toMatchObject({
      confirmation: "not_confirmed",
      signStatus: "refused",
      documentHash: DOCUMENT_HASH,
    });
  });

  it("treats an answer without a digest as a failure, not a signature", async () => {
    const harnessed = harness({ behavior: async () => ({ status: "signed" }) });
    await expect(runSign(harnessed)).rejects.toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.internalError,
    });
    expect(harnessed.journal.at(-1)?.details).toMatchObject({
      outcome: "error",
      documentHash: null,
    });
  });

  it("switches signing off once and journals it once", async () => {
    const harnessed = harness();
    const off = await harnessed.service.disableSigning({ actor: USER_ACTOR });
    expect(off.signing.enabled).toBe(false);
    const rows = harnessed.journal.filter((entry) => entry.action === "browser_bridge.signing.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({ enabled: false, mode: "auto" });
    await harnessed.service.disableSigning({ actor: USER_ACTOR });
    expect(harnessed.journal.filter((entry) => entry.action === "browser_bridge.signing.updated")).toHaveLength(1);
  });

  it("requires the typed arguments of browser.sign", () => {
    expect(validateActionParams("browser.sign", { documentRef: "x.pdf" }).ok).toBe(false);
    expect(validateActionParams("browser.sign", { actionType: "application.submit" }).ok).toBe(false);
    expect(validateActionParams("browser.sign", { ...SIGN_PARAMS, actionType: "Application Submit" }).ok).toBe(false);
    expect(validateActionParams("browser.sign", SIGN_PARAMS).ok).toBe(true);
  });
});