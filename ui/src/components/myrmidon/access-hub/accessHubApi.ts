// Access hub API client — the settings "Access hub" section (secrets the
// operator hands to agents, hosts and services).
//
// Wire contract: JSON over /api/myrmidon/access-hub.
//
// Secret values never travel back over this client: `AccessRecord` has no
// value field on purpose, and the listing, detail card, journal and every
// render path in this module must stay that way. The only value that ever
// leaves the UI is the one the operator types into a write dialog
// (create/rotate/set-value), and that write happens once.
import { api } from "@/api/client";

export type AccessKind = "ssh_key" | "password" | "token" | "oauth";

/** Where a secret is used or who holds it. Agent bindings are the grants. */
export interface AccessBinding {
  targetType: string;
  targetId: string;
  targetName: string;
  configPath: string | null;
}

/** One secret as the access hub reports it. Never carries a value. */
export interface AccessRecord {
  secretId: string;
  name: string;
  key: string;
  kind: AccessKind;
  status: string;
  latestVersion: number;
  createdAt: string;
  lastRotatedAt: string | null;
  bindings: AccessBinding[];
  hostRefs: string[];
  /** Public SSH fingerprint only — never the private half or a value. */
  fingerprint?: string | null;
}

/** A host from the fleet host registry (`GET /hosts`). */
export interface AccessHost {
  hostId: string;
  name: string;
  note?: string | null;
}

/** One journal line (`GET /audit`). */
export interface AccessAuditEntry {
  at: string;
  actor: string;
  action: string;
  secretName: string;
  targetName?: string | null;
  version?: number | null;
}

/** Public half of a freshly generated SSH key pair. Shown once. */
export interface SshKeyMaterial {
  secretId: string;
  publicKey: string;
  fingerprint: string;
}

export interface GenerateSshInput {
  name?: string;
  key?: string;
  /** Hosts the generated key is deployed to in the same step. */
  hostRefs?: string[];
}

export interface SaveSecretValueInput {
  /** Absent when creating a new secret. */
  secretId?: string;
  name?: string;
  key?: string;
  kind?: AccessKind;
  /** The write-only value. Never echoed back by the API. */
  value: string;
}

export interface RotateInput {
  value?: string;
  external?: boolean;
  restartContainers?: boolean;
}

export interface RotateResult {
  latestVersion: number;
  restartedContainers?: string[];
  hostRefs?: string[];
}

export interface SaveSecretValueResult {
  secretId: string;
  latestVersion?: number;
}

export interface SetHostRefsResult {
  hostRefs: string[];
}

const BASE = "/myrmidon/access-hub";

export const accessHubQueryKeys = {
  accesses: ["myrmidon", "access-hub", "accesses"] as const,
  hosts: ["myrmidon", "access-hub", "hosts"] as const,
  audit: ["myrmidon", "access-hub", "audit"] as const,
};

export const accessHubApi = {
  listAccesses: () => api.get<AccessRecord[]>(`${BASE}/accesses`),
  generateSshKey: (input: GenerateSshInput) =>
    api.post<SshKeyMaterial>(`${BASE}/secrets/generate-ssh`, input),
  saveSecretValue: (input: SaveSecretValueInput) =>
    api.post<SaveSecretValueResult>(`${BASE}/secrets`, input),
  grant: (secretId: string, targetAgentId: string) =>
    api.post<AccessRecord>(`${BASE}/accesses/${secretId}/grant`, { targetAgentId }),
  revoke: (secretId: string, targetAgentId: string) =>
    api.post<AccessRecord>(`${BASE}/accesses/${secretId}/revoke`, { targetAgentId }),
  rotate: (secretId: string, input: RotateInput) =>
    api.post<RotateResult>(`${BASE}/accesses/${secretId}/rotate`, input),
  audit: () => api.get<AccessAuditEntry[]>(`${BASE}/audit`),
  listHosts: () => api.get<AccessHost[]>(`${BASE}/hosts`),
  saveHost: (input: { hostId?: string; name: string; note?: string | null }) =>
    api.put<AccessHost>(`${BASE}/hosts`, input),
  // Deployment of a secret to hosts is one set-shaped write (deploy = union,
  // withdraw = difference); the contract sketch listed only the host registry
  // for /hosts, so this route is the agreed extension for the deploy/withdraw
  // actions and is what the sibling UI/API work has to implement.
  setHostRefs: (secretId: string, hostRefs: string[]) =>
    api.put<SetHostRefsResult>(`${BASE}/accesses/${secretId}/hosts`, { hostRefs }),
};

export const ACCESS_KIND_LABEL: Record<AccessKind, string> = {
  ssh_key: "SSH key",
  password: "Password",
  token: "Token",
  oauth: "OAuth",
};

export const ACCESS_KIND_ORDER: AccessKind[] = ["ssh_key", "password", "token", "oauth"];

/** Marker for "this agent is not a grant target" in the reference implementations. */
export const OTHER_BINDING_TYPES = ["host", "service"];

/** Agent bindings of a record: who was granted this access. */
export function grantedAgents(record: AccessRecord): AccessBinding[] {
  return record.bindings.filter((binding) => binding.targetType === "agent");
}

/** Non-agent bindings: where the secret is used (hosts, services). */
export function usedByBindings(record: AccessRecord): AccessBinding[] {
  return record.bindings.filter((binding) => binding.targetType !== "agent");
}

export function hostNameFor(hostId: string, hosts: AccessHost[]): string {
  return hosts.find((host) => host.hostId === hostId)?.name ?? hostId;
}

export function hostNamesFor(record: AccessRecord, hosts: AccessHost[]): string[] {
  return record.hostRefs.map((hostId) => hostNameFor(hostId, hosts));
}

/**
 * Machine-readable moment for the operator: fixed UTC shape, monospace in the
 * UI. `—` stands for "never" so the columns stay scannable.
 */
export function formatAccessMoment(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/**
 * The public half of a generated SSH key lives in memory only while its own
 * card is open: switching to another secret (or closing the card) drops it, so
 * reopening the card shows the fingerprint alone.
 */
export function sshRevealForSelection(
  reveal: SshKeyMaterial | null,
  selectedSecretId: string | null,
): SshKeyMaterial | null {
  if (!reveal || !selectedSecretId) return null;
  return reveal.secretId === selectedSecretId ? reveal : null;
}

export interface AccessListFilters {
  search: string;
  kind: AccessKind | "all";
  agent: string;
}

export const ALL_GRANTEES = "__all__";

export const EMPTY_ACCESS_FILTERS: AccessListFilters = {
  search: "",
  kind: "all",
  agent: ALL_GRANTEES,
};

export function filterAccessRecords(
  records: AccessRecord[],
  filters: AccessListFilters,
): AccessRecord[] {
  const needle = filters.search.trim().toLowerCase();
  return records.filter((record) => {
    if (filters.kind !== "all" && record.kind !== filters.kind) return false;
    if (filters.agent !== ALL_GRANTEES) {
      const holds = grantedAgents(record).some((binding) => binding.targetId === filters.agent);
      if (!holds) return false;
    }
    if (!needle) return true;
    return [
      record.name,
      record.key,
      ...grantedAgents(record).map((binding) => binding.targetName),
      ...usedByBindings(record).map((binding) => binding.targetName),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

/** Latest N journal entries, newest first. */
export function latestAuditEntries(entries: AccessAuditEntry[], limit: number): AccessAuditEntry[] {
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

export const DEFAULT_AUDIT_LIMIT = 50;