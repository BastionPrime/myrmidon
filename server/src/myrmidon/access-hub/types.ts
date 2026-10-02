// myrmidon(SEC1): access-hub module — types.
//
// Part A of the Secrets UI plan (server core): secret typing (ssh_key /
// password / token / oauth) on top of the existing company secrets, ssh key
// generation with a public part, the fleet host registry and the operation
// journal. Values live ONLY in the existing company secrets storage; this
// module adds metadata and API surface, never a second value store.
//
// Docs: docs/myrmidon/DIVERGENCE.md (track 5), docs/myrmidon/SETTINGS.md.

import type { SecretProvider } from "@paperclipai/shared";

/** Secret kinds the access hub distinguishes. Stored in the existing
 * `company_secrets.providerMetadata` JSON field under the `kind` key. */
export const ACCESS_HUB_SECRET_KINDS = ["ssh_key", "password", "token", "oauth"] as const;
export type AccessHubSecretKind = (typeof ACCESS_HUB_SECRET_KINDS)[number];

/** providerMetadata keys owned by this module. Other keys in that JSON field
 * belong to providers and are preserved untouched. */
export const ACCESS_HUB_KIND_KEY = "kind";
export const ACCESS_HUB_TARGET_USER_KEY = "targetUser";
export const ACCESS_HUB_HOST_REFS_KEY = "hostRefs";
export const ACCESS_HUB_FINGERPRINT_KEY = "sshFingerprint";
export const ACCESS_HUB_PUBLIC_KEY_KEY = "sshPublicKey";

/** ssh-specific metadata (kind = ssh_key): the login user on the target
 * hosts, the host registry ids the key is laid out on, and the public part
 * with its fingerprint. The public part is not a secret: showing it is
 * allowed, but it is returned by the generation response only; the list
 * endpoints expose only the fingerprint. */
export interface SshKeyMetadata {
  targetUser: string | null;
  hostRefs: string[];
  sshFingerprint: string | null;
  sshPublicKey: string | null;
}

/** The view of one secret in the access list. Deliberately WITHOUT any value
 * or value-like field: the list must not be able to leak a secret value. */
export interface AccessHubSecretView {
  id: string;
  companyId: string;
  key: string;
  name: string;
  provider: string;
  status: string;
  kind: AccessHubSecretKind | null;
  ssh: SshKeyFingerprintView | null;
  description: string | null;
  latestVersion: number;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
  lastRotatedAt: string | null;
}

/** What the list says about an ssh_key secret: no public part, no value. */
export interface SshKeyFingerprintView {
  fingerprint: string | null;
  targetUser: string | null;
  hostRefs: string[];
}

/** One entry of the fleet host registry (instance_settings.general,
 * key `myrmidonAccessHubHosts`). */
export interface AccessHubHost {
  id: string;
  name: string;
  address: string;
  targetUser: string;
  enabled: boolean;
}

/** Journal entry as served by the access hub log endpoint. */
export interface AccessHubLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export const ACCESS_HUB_ACTIVITY_ACTIONS = [
  "access_hub.secret.generated",
  "access_hub.access.granted",
  "access_hub.access.revoked",
  "access_hub.host.updated",
  "access_hub.hosts.set",
  "access_hub.secret.rotated",
  "access_hub.secret.typed",
] as const;
export type AccessHubActivityAction = (typeof ACCESS_HUB_ACTIVITY_ACTIONS)[number];

/** The result of ssh key generation: the secret row (as stored, metadata
 * only — the private part went into the value storage through the existing
 * create path and never leaves it again) plus the public part and its
 * fingerprint, returned ONCE in this response. */
export interface SshKeyGenerationResult {
  secret: AccessHubSecretView;
  publicKey: string;
  fingerprint: string;
}

/** The provider access-hub secrets are created with: the existing local
 * encrypted storage. No other value store is used (part A rule). */
export const ACCESS_HUB_SECRET_PROVIDER: SecretProvider = "local_encrypted";
