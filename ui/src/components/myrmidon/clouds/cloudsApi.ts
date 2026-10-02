// myrmidon(CLOUD-CONNECTOR): API client for the Settings → Clouds section.
// Server side: server/src/myrmidon/cloud-connector/routes.ts.

import { api } from "@/api/client";
import type {
  CloudAccessMode,
  CloudAccount,
  CloudGrant,
  CloudGrantTargetKind,
  CloudJournalEntry,
  CloudProviderId,
  CloudRoot,
  CloudRootKind,
} from "@paperclipai/shared/myrmidon-cloud-connector";

export const cloudsAccountsQueryKey = ["myrmidon", "clouds", "accounts"] as const;
export const cloudsRootsQueryKey = ["myrmidon", "clouds", "roots"] as const;
export const cloudsGrantsQueryKey = ["myrmidon", "clouds", "grants"] as const;
export const cloudsJournalQueryKey = ["myrmidon", "clouds", "journal"] as const;

export interface CloudFolderEntry {
  name: string;
  type: "file" | "folder";
  size: number | null;
  modified: string | null;
  children: number | null;
}

export interface CloudFolderListing {
  path: string;
  items: CloudFolderEntry[];
  truncated: boolean;
}

export interface NewRootInput {
  providerId: CloudProviderId;
  name: string;
  kind: CloudRootKind;
  description?: string;
  driveId?: string;
  itemId?: string;
  folder?: string;
}

export interface NewGrantInput {
  rootId: string;
  targetKind: CloudGrantTargetKind;
  agentId?: string;
  caste?: string;
  mode: CloudAccessMode;
}

function company(companyId: string): string {
  return `companyId=${encodeURIComponent(companyId)}`;
}

export const cloudsApi = {
  accounts: (companyId: string) =>
    api.get<{ accounts: CloudAccount[] }>(`/myrmidon/cloud-connector/accounts?${company(companyId)}`),
  startConnect: (providerId: CloudProviderId, companyId: string, displayName?: string) =>
    api.post<{ providerId: CloudProviderId; authorizeUrl: string; state: string }>(
      `/myrmidon/cloud-connector/oauth/${encodeURIComponent(providerId)}/start`,
      { companyId, displayName },
    ),
  disconnectAccount: (accountId: string, companyId: string) =>
    api.delete<{ removed: boolean }>(
      `/myrmidon/cloud-connector/accounts/${encodeURIComponent(accountId)}?${company(companyId)}`,
    ),
  roots: (companyId: string) =>
    api.get<{ roots: CloudRoot[] }>(`/myrmidon/cloud-connector/roots?${company(companyId)}`),
  addRoot: (companyId: string, input: NewRootInput) =>
    api.post<{ root: CloudRoot }>("/myrmidon/cloud-connector/roots", { companyId, ...input }),
  removeRoot: (rootId: string, companyId: string) =>
    api.delete<{ removed: boolean }>(
      `/myrmidon/cloud-connector/roots/${encodeURIComponent(rootId)}?${company(companyId)}`,
    ),
  grants: (companyId: string) =>
    api.get<{ grants: CloudGrant[] }>(`/myrmidon/cloud-connector/grants?${company(companyId)}`),
  setGrant: (companyId: string, input: NewGrantInput) =>
    api.put<{ grant: CloudGrant }>(`/myrmidon/cloud-connector/grants?${company(companyId)}`, input),
  removeGrant: (grantId: string, companyId: string) =>
    api.delete<{ removed: boolean }>(
      `/myrmidon/cloud-connector/grants/${encodeURIComponent(grantId)}?${company(companyId)}`,
    ),
  journal: (companyId: string, limit = 100) =>
    api.get<{ entries: CloudJournalEntry[] }>(
      `/myrmidon/cloud-connector/journal?${company(companyId)}&limit=${limit}`,
    ),
  tree: (companyId: string, providerId: CloudProviderId, root: string, path: string) =>
    api.get<{ listing: CloudFolderListing }>(
      `/myrmidon/cloud-connector/tree?${company(companyId)}&providerId=${encodeURIComponent(providerId)}`
      + `&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
};

/** Providers the connector can connect, in the order the panel offers them. */
export const CLOUD_PROVIDER_LABELS: Array<{ id: CloudProviderId; label: string }> = [
  { id: "onedrive", label: "OneDrive" },
  { id: "google-drive", label: "Google Drive" },
  { id: "yandex-disk", label: "Yandex Disk" },
];

/** Who a grant is for, spelled out for the owner. */
export function grantTargetLabel(grant: CloudGrant): string {
  switch (grant.targetKind) {
    case "agent":
      return `agent ${grant.agentId ?? "?"}`;
    case "caste":
      return `caste ${grant.caste ?? "?"}`;
    case "all":
      return "everyone";
  }
}

export function rootKindLabel(root: CloudRoot): string {
  return root.kind === "shared" ? "shared with us (read only)" : "in the connected account";
}