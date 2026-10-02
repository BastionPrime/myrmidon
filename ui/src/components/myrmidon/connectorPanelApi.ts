// myrmidon(EXTCASE-PANEL): the connector panel's API client.
//
// Every call goes to the browser-bridge panel routes of part B:
// `/api/myrmidon/browser-bridge/...`. Reads the company devices and the
// journal; writes pairing codes, the allowlist and the signing policy.
// The UI never touches the extension's endpoints — those belong to the
// device, and the device holds its own bridge token.

import { api } from "@/api/client";

export interface BridgeDeviceView {
  deviceId: string;
  label: string | null;
  extVersion: string;
  capabilities: string[];
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
}

export interface BridgeSigningSettings {
  enabled: boolean;
  mode: "auto" | "manual" | "types";
  types: string[];
  dailyLimit: number;
}

export interface BridgeSettings {
  domains: string[];
  signing: BridgeSigningSettings;
}

export interface BridgePairingCode {
  code: string;
  codeId: string;
  expiresAt: string;
}

export interface BridgeJournalRow {
  id: string;
  createdAt: string;
  action: string;
  deviceId: string | null;
  label: string | null;
  method: string | null;
  url: string | null;
  target: string | null;
  outcome: string | null;
  confirmation: string | null;
  durationMs: number | null;
  reasonCode: number | null;
  signActionType: string | null;
  signStatus: string | null;
  documentHash: string | null;
  actorType: string | null;
  actorId: string | null;
  runId: string | null;
}

export interface BridgeJournalQuery {
  deviceId?: string;
  method?: string;
  outcome?: string;
  signaturesOnly?: boolean;
  from?: string;
  to?: string;
  limit?: number;
}

export interface BridgeJournalPage {
  rows: BridgeJournalRow[];
  signedToday: number | null;
  dailyLimit: number;
}

export const bridgeDevicesQueryKey = (companyId: string) => ["myrmidon", "browser-bridge", "devices", companyId] as const;
export const bridgeSettingsQueryKey = ["myrmidon", "browser-bridge", "settings"] as const;
export const bridgeJournalQueryKey = (companyId: string, query: BridgeJournalQuery) =>
  ["myrmidon", "browser-bridge", "journal", companyId, query] as const;

function journalSearchParams(query: BridgeJournalQuery): string {
  const params = new URLSearchParams();
  if (query.deviceId) params.set("deviceId", query.deviceId);
  if (query.method) params.set("method", query.method);
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.signaturesOnly) params.set("signaturesOnly", "true");
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.limit) params.set("limit", String(query.limit));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export const bridgeApi = {
  listDevices: (companyId: string) =>
    api.get<{ devices: BridgeDeviceView[] }>(`/myrmidon/browser-bridge/companies/${companyId}/devices`),
  createPairingCode: (companyId: string, label?: string) =>
    api.post<BridgePairingCode>(`/myrmidon/browser-bridge/companies/${companyId}/pairing-codes`, label ? { label } : {}),
  revokeDevice: (companyId: string, deviceId: string) =>
    api.delete<{ deviceId: string; revoked: boolean }>(`/myrmidon/browser-bridge/companies/${companyId}/devices/${encodeURIComponent(deviceId)}`),
  getSettings: () => api.get<BridgeSettings>("/myrmidon/browser-bridge/settings"),
  updateSettings: (patch: { domains?: string[]; signing?: BridgeSigningSettings }) =>
    api.patch<BridgeSettings>("/myrmidon/browser-bridge/settings", patch),
  disableSigning: () => api.post<{ signing: BridgeSigningSettings }>("/myrmidon/browser-bridge/signing/disable", {}),
  journal: (companyId: string, query: BridgeJournalQuery) =>
    api.get<BridgeJournalPage>(`/myrmidon/browser-bridge/companies/${companyId}/journal${journalSearchParams(query)}`),
};

/** A stable "how long ago" description for `lastSeenAt`/`pairedAt`. */
export function describeSeenAt(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
