// myrmidon(EXTCASE-B): the browser-bridge service — pairing, devices, allowlist, actions.
//
// This is the whole behaviour of the gateway behind one injected-deps object, so
// it can be exercised without a socket, a database or a secret provider:
//
// - `createPairingCode` / `exchangePairingCode` implement design note §4.2. The
//   code is one-shot and short-lived; the exchange hands the extension a
//   long-lived bridge token bound to its deviceId, stores the device (token in
//   the board's secret storage, record in the secret's metadata) and journals
//   both steps;
// - `revokeDevice` deletes the record and drops the live connection in the same
//   call, so revocation is fail-closed;
// - `runAction` is the gate the bot's browser tools go through: device paired,
//   capability declared by the extension, domain inside the company allowlist,
//   then the transport dispatch with the action or the human-confirmation
//   timeout. Every outcome — executed, denied, timed out — becomes one journal
//   row before the caller sees it.
//
// The gateway checks the allowlist even though the extension does too: the
// extension is a client on a machine we do not control, so it is the weaker half
// of the pair (design note §4.4, "defense in depth").

import {
  BROWSER_BRIDGE_ERROR_CODES,
  BROWSER_BRIDGE_METHOD_CAPABILITY,
  BRIDGE_ACTION_TIMEOUT_MS,
  BRIDGE_CONFIRMATION_TIMEOUT_MS,
  PAIRING_CODE_TTL_MS,
  isUrlAllowedByAllowlist,
  normalizeAllowlistDomains,
  normalizeCapabilitySet,
  normalizePairingCode,
  validateActionParams,
  type BrowserBridgeActionParams,
  type BrowserBridgeCapability,
  type BrowserBridgeMethod,
  type BrowserBridgeSettings,
  type PairingExchangeRequest,
} from "@paperclipai/shared";
import {
  actionEntry,
  allowlistUpdatedEntry,
  devicePairedEntry,
  deviceRevokedEntry,
  pairingCreatedEntry,
  pairingRejectedEntry,
  type BrowserBridgeActor,
  type BrowserBridgeJournalEntry,
} from "./journal.js";
import type { InMemoryBridgeSessionRegistry } from "./sessions.js";
import {
  generateBridgeToken,
  generatePairingCode,
  hashSecret,
  isSafeDeviceId,
  tokenMatchesDigest,
  type RandomBytes,
} from "./tokens.js";
import type { BridgeDeviceRecord, BridgeDeviceStore, PairingCodeStore } from "./store.js";

/** A refusal that carries the JSON-RPC application code the bot (and the journal) sees. */
export class BrowserBridgeError extends Error {
  constructor(
    readonly reasonCode: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrowserBridgeError";
  }
}

export interface BrowserBridgeSettingsPort {
  getGeneral(): Promise<{ browserBridge?: unknown }>;
  updateGeneral(patch: { browserBridge: BrowserBridgeSettings }): Promise<unknown>;
}

export interface BrowserBridgeDispatchInput {
  deviceId: string;
  companyId: string;
  method: BrowserBridgeMethod;
  params: BrowserBridgeActionParams;
  timeoutMs: number;
  requiresConfirmation: boolean;
  /** Caller-supplied replay key (run + tool-call id); replays reuse the first answer. */
  idempotencyKey?: string;
}

/** Everything the service needs; tests replace each port with a fake. */
export interface BrowserBridgeServiceDeps {
  pairings: PairingCodeStore;
  devices: BridgeDeviceStore;
  sessions: InMemoryBridgeSessionRegistry;
  settings: BrowserBridgeSettingsPort;
  /** Every company on the instance — the allowlist is instance-wide, so is its journal row. */
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BrowserBridgeJournalEntry): Promise<unknown>;
  /** Board pepper for the HMAC of codes and tokens; never comes from settings. */
  pepper: string;
  now?: () => number;
  randomBytes?: RandomBytes;
  generateCode?: () => string;
  generateToken?: BridgeTokenFactory;
  /** Transport dispatch to a connected device; supplied by the WSS layer. */
  dispatch?(input: BrowserBridgeDispatchInput): Promise<unknown>;
}

export type BridgeTokenFactory = (input: { companyId: string; deviceId: string }) => string;

export interface DeviceView {
  deviceId: string;
  label: string | null;
  extVersion: string;
  capabilities: BrowserBridgeCapability[];
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
}

export interface CreatedPairingCode {
  code: string;
  codeId: string;
  expiresAt: string;
}

export interface PairedDevice {
  deviceId: string;
  token: string;
  capabilities: BrowserBridgeCapability[];
  allowlist: string[];
  pairedAt: string;
}

export interface ActionRunResult {
  result: unknown;
  confirmation: "not_required" | "confirmed";
  durationMs: number;
}

export interface BrowserBridgeService {
  createPairingCode(input: { companyId: string; actor: BrowserBridgeActor; label?: string | null }): Promise<CreatedPairingCode>;
  exchangePairingCode(input: {
    request: PairingExchangeRequest;
    actor: BrowserBridgeActor;
  }): Promise<PairedDevice>;
  listDevices(companyId: string): Promise<DeviceView[]>;
  revokeDevice(input: { companyId: string; deviceId: string; actor: BrowserBridgeActor }): Promise<{ revoked: boolean }>;
  readSettings(): Promise<BrowserBridgeSettings>;
  updateSettings(input: { settings: BrowserBridgeSettings; actor: BrowserBridgeActor }): Promise<BrowserBridgeSettings>;
  /** Authenticate a device's bridge token; refuses revoked and unknown devices. */
  authenticateDevice(input: { companyId: string; deviceId: string; token: string }): Promise<BridgeDeviceRecord>;
  runAction(input: {
    companyId: string;
    deviceId: string;
    method: BrowserBridgeMethod;
    params: unknown;
    actor: BrowserBridgeActor;
    /** Replay key from the caller (e.g. run + tool-call id). */
    requestId?: string;
  }): Promise<ActionRunResult>;
}

const SYSTEM_ACTOR: BrowserBridgeActor = {
  actorType: "system",
  actorId: "browser-bridge",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

export function browserBridgeService(
  deps: BrowserBridgeServiceDeps,
): BrowserBridgeService {
  const now = deps.now ?? (() => Date.now());
  const makeCode = deps.generateCode ?? (() => generatePairingCode(deps.randomBytes));
  const makeToken = deps.generateToken ?? ((input) => generateBridgeToken(input, deps.randomBytes));

  async function readSettings(): Promise<BrowserBridgeSettings> {
    const general = await deps.settings.getGeneral();
    const stored = general.browserBridge as { domains?: unknown } | undefined;
    return { domains: normalizeAllowlistDomains(stored?.domains) };
  }

  function requireDispatch() {
    if (!deps.dispatch) {
      throw new BrowserBridgeError(
        BROWSER_BRIDGE_ERROR_CODES.internalError,
        "the bridge transport is not attached",
      );
    }
    return deps.dispatch;
  }

  return {
    readSettings,

    async createPairingCode({ companyId, actor, label }) {
      const code = makeCode();
      const codeId = `pc_${hashSecret(`${code}:${now()}`, deps.pepper).slice(0, 16)}`;
      const createdAt = now();
      const expiresAt = createdAt + PAIRING_CODE_TTL_MS;
      await deps.pairings.put({
        companyId,
        codeDigest: hashSecret(code, deps.pepper),
        label: label ?? null,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdAt,
        expiresAt,
        consumedAt: null,
      });
      await deps.logActivity(
        pairingCreatedEntry({
          ...actor,
          companyId,
          entityType: "browser_bridge",
          codeId,
          label: label ?? null,
          expiresAt: new Date(expiresAt).toISOString(),
        }),
      );
      return { code, codeId, expiresAt: new Date(expiresAt).toISOString() };
    },

    async exchangePairingCode({ request, actor }) {
      const canonical = normalizePairingCode(request.code);
      if (!canonical) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.pairingCodeInvalid, "invalid pairing code");
      }
      if (!isSafeDeviceId(request.deviceId)) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.invalidParams, "invalid deviceId");
      }
      const codeDigest = hashSecret(canonical, deps.pepper);
      const codeId = `pc_${codeDigest.slice(0, 16)}`;
      const consumed = await deps.pairings.consume({ codeDigest, now: now() });
      if (consumed.status !== "ok") {
        const reasonCode =
          consumed.status === "expired"
            ? BROWSER_BRIDGE_ERROR_CODES.pairingCodeExpired
            : BROWSER_BRIDGE_ERROR_CODES.pairingCodeInvalid;
        // An unknown digest names no company, so nothing can be attributed and
        // nothing is written; a known-but-spent or expired code is journaled.
        if (consumed.status !== "missing") {
          await deps.logActivity(
            pairingRejectedEntry({
              ...SYSTEM_ACTOR,
              companyId: consumed.companyId,
              entityType: "browser_bridge",
              codeId,
              reason: consumed.status,
              deviceId: request.deviceId,
            }),
          );
        }
        throw new BrowserBridgeError(reasonCode, `pairing code ${consumed.status}`);
      }
      const companyId = consumed.record.companyId;

      const capabilities = normalizeCapabilitySet(request.capabilities ?? []);
      if (capabilities === null) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.invalidParams, "unknown capability");
      }

      // Re-pairing the same deviceId replaces the record: one device, one token.
      const existing = await deps.devices.get(companyId, request.deviceId);
      if (existing) {
        await deps.devices.revoke(companyId, request.deviceId, new Date(now()).toISOString());
      }

      const token = makeToken({ companyId, deviceId: request.deviceId });
      const pairedAt = new Date(now()).toISOString();
      const record: BridgeDeviceRecord = {
        companyId,
        deviceId: request.deviceId,
        label: consumed.record.label,
        tokenDigest: hashSecret(token, deps.pepper),
        extVersion: request.extVersion,
        capabilities,
        pairedAt,
        lastSeenAt: null,
        revokedAt: null,
      };
      await deps.devices.create(record, token, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      await deps.logActivity(
        devicePairedEntry({
          ...SYSTEM_ACTOR,
          companyId,
          entityType: "browser_bridge",
          deviceId: record.deviceId,
          label: record.label,
          extVersion: record.extVersion,
          capabilities: record.capabilities,
          codeId,
        }),
      );

      return {
        deviceId: record.deviceId,
        token,
        capabilities: record.capabilities,
        allowlist: (await readSettings()).domains,
        pairedAt,
      };
    },

    async listDevices(companyId) {
      const records = await deps.devices.list(companyId);
      return records
        .filter((record) => !record.revokedAt)
        .map((record) => ({
          deviceId: record.deviceId,
          label: record.label,
          extVersion: record.extVersion,
          capabilities: record.capabilities,
          pairedAt: record.pairedAt,
          lastSeenAt: record.lastSeenAt,
          connected: deps.sessions.isConnected(record.deviceId),
        }));
    },

    async revokeDevice({ companyId, deviceId, actor }) {
      const at = new Date(now()).toISOString();
      // Drop the live connection first: an authenticated socket must stop acting
      // in the same breath the record goes away (fail-closed revocation).
      deps.sessions.disconnect(deviceId, "device revoked from the bridge panel");
      const revoked = await deps.devices.revoke(companyId, deviceId, at);
      if (revoked) {
        await deps.logActivity(
          deviceRevokedEntry({
            ...actor,
            companyId,
            entityType: "browser_bridge",
            deviceId,
          }),
        );
      }
      return { revoked };
    },

    async updateSettings({ settings, actor }) {
      const next: BrowserBridgeSettings = { domains: normalizeAllowlistDomains(settings.domains) };
      await deps.settings.updateGeneral({ browserBridge: next });
      const companyIds = await deps.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          deps.logActivity(
            allowlistUpdatedEntry({
              ...actor,
              companyId,
              entityType: "browser_bridge",
              domains: next.domains,
            }),
          ),
        ),
      );
      return next;
    },

    async authenticateDevice({ companyId, deviceId, token }) {
      const record = await deps.devices.get(companyId, deviceId);
      if (!record) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.notPaired, "device is not paired");
      }
      if (!tokenMatchesDigest(token, record.tokenDigest, deps.pepper)) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.revoked, "bridge token is not valid for this device");
      }
      return record;
    },

    async runAction({ companyId, deviceId, method, params, actor, requestId }) {
      const record = await deps.devices.get(companyId, deviceId);
      if (!record) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.notPaired, "device is not paired");
      }
      const session = deps.sessions.get(deviceId);
      if (!session) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.deviceOffline, "device is not connected");
      }
      const capability = BROWSER_BRIDGE_METHOD_CAPABILITY[method];
      if (!session.capabilities.includes(capability)) {
        await deps.logActivity(
          actionEntry({
            ...actor,
            companyId,
            entityType: "browser_bridge",
            deviceId,
            method,
            url: null,
            target: null,
            outcome: "denied",
            confirmation: "not_required",
            durationMs: 0,
            reasonCode: BROWSER_BRIDGE_ERROR_CODES.capabilityUnsupported,
            result: null,
          }),
        );
        throw new BrowserBridgeError(
          BROWSER_BRIDGE_ERROR_CODES.capabilityUnsupported,
          `the extension did not declare the "${capability}" capability`,
        );
      }

      const validated = validateActionParams(method, params);
      if (!validated.ok) {
        throw new BrowserBridgeError(BROWSER_BRIDGE_ERROR_CODES.invalidParams, validated.message);
      }
      const actionParams = validated.params;
      const url = actionParams.url ?? null;
      const target = actionParams.target ?? null;

      if (url) {
        const allowlist = (await readSettings()).domains;
        if (!isUrlAllowedByAllowlist(url, allowlist)) {
          await deps.logActivity(
            actionEntry({
              ...actor,
              companyId,
              entityType: "browser_bridge",
              deviceId,
              method,
              url,
              target,
              outcome: "denied",
              confirmation: "not_required",
              durationMs: 0,
              reasonCode: BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed,
              result: null,
            }),
          );
          throw new BrowserBridgeError(
            BROWSER_BRIDGE_ERROR_CODES.domainNotAllowed,
            "the url is outside the bridge allowlist",
            { url },
          );
        }
      }

      const requiresConfirmation = actionParams.confirmation === "human";
      const timeoutMs = requiresConfirmation ? BRIDGE_CONFIRMATION_TIMEOUT_MS : BRIDGE_ACTION_TIMEOUT_MS;
      const startedAt = now();
      const confirmation = requiresConfirmation ? "confirmed" : "not_required";
      try {
        const result = await requireDispatch()({
          deviceId,
          companyId,
          method,
          params: actionParams,
          timeoutMs,
          requiresConfirmation,
          ...(requestId ? { idempotencyKey: `${deviceId}:${requestId}` } : {}),
        });
        const durationMs = now() - startedAt;
        await deps.logActivity(
          actionEntry({
            ...actor,
            companyId,
            entityType: "browser_bridge",
            deviceId,
            method,
            url,
            target,
            outcome: "ok",
            confirmation,
            durationMs,
            reasonCode: null,
            result,
          }),
        );
        await deps.devices.touch(companyId, deviceId, new Date(now()).toISOString());
        return { result, confirmation, durationMs };
      } catch (err) {
        const refusal =
          err instanceof BrowserBridgeError
            ? err
            : new BrowserBridgeError(
                BROWSER_BRIDGE_ERROR_CODES.internalError,
                err instanceof Error ? err.message : String(err),
              );
        const timedOut = refusal.reasonCode === BROWSER_BRIDGE_ERROR_CODES.timeout;
        await deps.logActivity(
          actionEntry({
            ...actor,
            companyId,
            entityType: "browser_bridge",
            deviceId,
            method,
            url,
            target,
            outcome: timedOut ? "timeout" : "error",
            confirmation: timedOut && requiresConfirmation ? "not_confirmed" : confirmation,
            durationMs: now() - startedAt,
            reasonCode: refusal.reasonCode,
            result: null,
          }),
        );
        throw refusal;
      }
    },
  };
}