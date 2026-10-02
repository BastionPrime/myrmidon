// myrmidon(EXTCASE-B): persistence ports of the browser bridge.
//
// Pairing codes and paired devices have different needs, so they get different
// stores:
//
// - a pairing code lives 15 minutes and is spent on first use. The store is
//   in-memory and single-process, which is what the board is: a restart drops
//   pending codes, and that is safe — an unconsumed code simply stops working,
//   and the panel issues a new one. Spending the code is one method call, so
//   two exchanges of the same code cannot both win;
// - a paired device is durable and revocable, so it lives in the board's secret
//   storage as a company secret (`browser_bridge.device.<deviceId>`): the value
//   is the bridge token itself (the vault encrypts it, nothing resolves it in
//   the happy path) and the device record — label, capabilities, timestamps,
//   token digest — is the secret's provider metadata. Revoking is a delete, so
//   it is fail-closed: no record, no authentication.

import type { BrowserBridgeCapability } from "@paperclipai/shared";
import { BRIDGE_DEVICE_SECRET_PREFIX } from "./tokens.js";

export interface StoredPairingCode {
  companyId: string;
  /** HMAC digest of the canonical code; the code itself is never stored. */
  codeDigest: string;
  label: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export type PairingCodeConsumeResult =
  | { status: "missing" }
  | { status: "expired" | "consumed"; companyId: string }
  | { status: "ok"; record: StoredPairingCode };

export interface PairingCodeStore {
  put(record: StoredPairingCode): Promise<void>;
  /**
   * One-shot spend keyed by the code digest alone: the code's HMAC is unique, and
   * the extension that presents it does not know the company — the record does.
   * The first caller wins, every later one sees `consumed`.
   */
  consume(input: { codeDigest: string; now: number }): Promise<PairingCodeConsumeResult>;
  /** Test/inspection helper; the service never lists codes. */
  size(): Promise<number>;
}

export class InMemoryPairingCodeStore implements PairingCodeStore {
  private readonly records = new Map<string, StoredPairingCode>();

  async put(record: StoredPairingCode): Promise<void> {
    this.records.set(record.codeDigest, { ...record });
  }

  async consume(input: { codeDigest: string; now: number }): Promise<PairingCodeConsumeResult> {
    const key = input.codeDigest;
    const record = this.records.get(key);
    if (!record) return { status: "missing" };
    if (record.consumedAt !== null) return { status: "consumed", companyId: record.companyId };
    if (record.expiresAt <= input.now) {
      const companyId = record.companyId;
      this.records.delete(key);
      return { status: "expired", companyId };
    }
    record.consumedAt = input.now;
    this.records.set(key, record);
    return { status: "ok", record: { ...record } };
  }

  async size(): Promise<number> {
    return this.records.size;
  }
}

export interface BridgeDeviceRecord {
  companyId: string;
  deviceId: string;
  label: string | null;
  /** HMAC digest of the bridge token in the secret's value. */
  tokenDigest: string;
  extVersion: string;
  capabilities: BrowserBridgeCapability[];
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface BridgeDeviceStore {
  /** Persist a newly paired device; the token is handed to the vault, not kept in the record. */
  create(
    record: BridgeDeviceRecord,
    token: string,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<void>;
  /** The live record, or null when the device was never paired or was revoked. */
  get(companyId: string, deviceId: string): Promise<BridgeDeviceRecord | null>;
  list(companyId: string): Promise<BridgeDeviceRecord[]>;
  revoke(companyId: string, deviceId: string, at: string): Promise<boolean>;
  touch(companyId: string, deviceId: string, at: string): Promise<void>;
}

export class InMemoryBridgeDeviceStore implements BridgeDeviceStore {
  private readonly devices = new Map<string, BridgeDeviceRecord>();

  private key(companyId: string, deviceId: string): string {
    return `${companyId}:${deviceId}`;
  }

  async create(record: BridgeDeviceRecord, token: string): Promise<void> {
    void token;
    this.devices.set(this.key(record.companyId, record.deviceId), { ...record });
  }

  async get(companyId: string, deviceId: string): Promise<BridgeDeviceRecord | null> {
    const record = this.devices.get(this.key(companyId, deviceId));
    if (!record || record.revokedAt) return null;
    return { ...record };
  }

  async list(companyId: string): Promise<BridgeDeviceRecord[]> {
    return [...this.devices.values()]
      .filter((record) => record.companyId === companyId)
      .map((record) => ({ ...record }))
      .sort((a, b) => a.pairedAt.localeCompare(b.pairedAt));
  }

  async revoke(companyId: string, deviceId: string, at: string): Promise<boolean> {
    const key = this.key(companyId, deviceId);
    const record = this.devices.get(key);
    if (!record) return false;
    record.revokedAt = at;
    this.devices.set(key, record);
    return true;
  }

  async touch(companyId: string, deviceId: string, at: string): Promise<void> {
    const key = this.key(companyId, deviceId);
    const record = this.devices.get(key);
    if (!record) return;
    record.lastSeenAt = at;
    this.devices.set(key, record);
  }
}

/** The slice of the board's secret service the device store needs. */
export interface BridgeSecretRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  providerMetadata: Record<string, unknown> | null;
  status: string;
}

export interface BridgeSecretPort {
  list(companyId: string): Promise<BridgeSecretRecord[]>;
  create(
    companyId: string,
    input: {
      name: string;
      key: string;
      description: string | null;
      providerMetadata: Record<string, unknown>;
      value: string;
      actor?: { userId?: string | null; agentId?: string | null };
    },
  ): Promise<{ id: string }>;
  update(
    secretId: string,
    patch: { description?: string | null; providerMetadata?: Record<string, unknown> | null },
  ): Promise<unknown>;
  remove(secretId: string): Promise<unknown>;
}

function readRecord(secret: BridgeSecretRecord): BridgeDeviceRecord | null {
  const metadata = secret.providerMetadata;
  if (!metadata || metadata.bridgeKind !== "device") return null;
  const { deviceId, companyId, tokenDigest, extVersion, capabilities, pairedAt, lastSeenAt, revokedAt, label } =
    metadata as Record<string, unknown>;
  if (typeof deviceId !== "string" || typeof companyId !== "string" || typeof tokenDigest !== "string") return null;
  if (typeof pairedAt !== "string") return null;
  return {
    companyId,
    deviceId,
    label: typeof label === "string" ? label : null,
    tokenDigest,
    extVersion: typeof extVersion === "string" ? extVersion : "",
    capabilities: Array.isArray(capabilities) ? (capabilities as BrowserBridgeCapability[]) : [],
    pairedAt,
    lastSeenAt: typeof lastSeenAt === "string" ? lastSeenAt : null,
    revokedAt: typeof revokedAt === "string" ? revokedAt : null,
  };
}

function toMetadata(record: BridgeDeviceRecord): Record<string, unknown> {
  return {
    bridgeKind: "device",
    companyId: record.companyId,
    deviceId: record.deviceId,
    label: record.label,
    tokenDigest: record.tokenDigest,
    extVersion: record.extVersion,
    capabilities: record.capabilities,
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
    revokedAt: record.revokedAt,
  };
}

/**
 * Device store over the board's company secrets. A row without the
 * `bridgeKind: "device"` marker — or one an operator disabled — is skipped, so
 * an unrelated secret that happens to start with the prefix cannot be read as a
 * device and cannot authenticate anyone.
 */
export class SecretBackedBridgeDeviceStore implements BridgeDeviceStore {
  constructor(private readonly secrets: BridgeSecretPort) {}

  private async find(companyId: string, deviceId: string): Promise<BridgeSecretRecord | null> {
    const key = `${BRIDGE_DEVICE_SECRET_PREFIX}${deviceId}`;
    const rows = await this.secrets.list(companyId);
    return rows.find((row) => row.key === key && row.status === "active") ?? null;
  }

  async get(companyId: string, deviceId: string): Promise<BridgeDeviceRecord | null> {
    const secret = await this.find(companyId, deviceId);
    if (!secret) return null;
    const parsed = readRecord(secret);
    if (!parsed || parsed.revokedAt) return null;
    return parsed;
  }

  async list(companyId: string): Promise<BridgeDeviceRecord[]> {
    const rows = await this.secrets.list(companyId);
    return rows
      .filter((row) => row.key.startsWith(BRIDGE_DEVICE_SECRET_PREFIX) && row.status === "active")
      .map((row) => readRecord(row))
      .filter((record): record is BridgeDeviceRecord => record !== null)
      .sort((a, b) => a.pairedAt.localeCompare(b.pairedAt));
  }

  async revoke(companyId: string, deviceId: string, at: string): Promise<boolean> {
    const secret = await this.find(companyId, deviceId);
    if (!secret) return false;
    const parsed = readRecord(secret);
    if (!parsed) return false;
    await this.secrets.update(secret.id, { providerMetadata: toMetadata({ ...parsed, revokedAt: at }) });
    await this.secrets.remove(secret.id);
    return true;
  }

  async touch(companyId: string, deviceId: string, at: string): Promise<void> {
    const secret = await this.find(companyId, deviceId);
    if (!secret) return;
    const parsed = readRecord(secret);
    if (!parsed) return;
    await this.secrets.update(secret.id, {
      providerMetadata: toMetadata({ ...parsed, lastSeenAt: at }),
    });
  }

  /** Persist a brand-new device: the token is the secret value, the record its metadata. */
  async create(
    record: BridgeDeviceRecord,
    token: string,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<void> {
    await this.secrets.create(record.companyId, {
      name: `Browser bridge device ${record.deviceId}`,
      key: `${BRIDGE_DEVICE_SECRET_PREFIX}${record.deviceId}`,
      description: record.label,
      providerMetadata: toMetadata(record),
      value: token,
      actor,
    });
  }
}

export { readRecord as readDeviceRecord, toMetadata as deviceRecordToMetadata };