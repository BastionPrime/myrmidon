// myrmidon(CLOUD-CONNECTOR): the access model.
//
// The owner keeps a list of roots (folders the connector account can reach)
// and grants them to an agent, a caste, or everyone, with a mode of `ro` or
// `rw`. An agent only ever addresses `(root, path)`: the connector resolves
// the root, picks the most specific grant, and refuses everything else. A
// folder shared with us by another account is read-only by construction, so
// `rw` on a shared root is rejected when the grant is written and again when
// it is used.
//
// The rules here are pure so the acceptance case ("reads and writes its own,
// reads the shared folder, never reaches anyone else's") is provable without
// a network or a cloud account.

import {
  CLOUD_PERSONAL_ROOT_ALIAS,
  type CloudAccessMode,
  type CloudGrant,
  type CloudGrantTargetKind,
  type CloudResolvedAccess,
  type CloudRoot,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import type { CloudAgentIdentity } from "./types.js";

export const GRANT_SPECIFICITY: Record<CloudGrantTargetKind, number> = {
  agent: 3,
  caste: 2,
  all: 1,
};

export function appliesTo(grant: CloudGrant, identity: CloudAgentIdentity): boolean {
  switch (grant.targetKind) {
    case "agent":
      return grant.agentId === identity.agentId;
    case "caste":
      return identity.caste !== null && grant.caste === identity.caste;
    case "all":
      return true;
  }
}

/** `rw` is impossible on a folder another account shared with us. */
export function assertModeAllowedForRoot(root: CloudRoot, mode: CloudAccessMode): void {
  if (root.kind === "shared" && mode === "rw") {
    throw new Error(`root ${root.name} is shared with us read-only; a read-write grant is not possible`);
  }
}

/** Effective access of one agent: the most specific grant per root wins. */
export function resolveAccess(
  roots: readonly CloudRoot[],
  grants: readonly CloudGrant[],
  identity: CloudAgentIdentity,
): CloudResolvedAccess[] {
  const byRoot = new Map<string, CloudResolvedAccess>();
  for (const grant of grants) {
    if (!appliesTo(grant, identity)) continue;
    const root = roots.find((candidate) => candidate.id === grant.rootId);
    if (!root) continue;
    if (root.kind === "shared" && grant.mode === "rw") continue;
    const current = byRoot.get(root.id);
    if (!current || GRANT_SPECIFICITY[grant.targetKind] > GRANT_SPECIFICITY[current.via]) {
      byRoot.set(root.id, { root, mode: grant.mode, via: grant.targetKind });
    } else if (GRANT_SPECIFICITY[grant.targetKind] === GRANT_SPECIFICITY[current.via] && grant.mode === "rw") {
      byRoot.set(root.id, { root, mode: "rw", via: grant.targetKind });
    }
  }
  return [...byRoot.values()].sort((a, b) => a.root.name.localeCompare(b.root.name));
}

/** Resolve a root the agent named. Returns null when the agent may not see it at all. */
export function resolveNamedRoot(
  roots: readonly CloudRoot[],
  grants: readonly CloudGrant[],
  identity: CloudAgentIdentity,
  name: string,
): CloudResolvedAccess | null {
  const wanted = name.trim().toLowerCase();
  const root = roots.find((candidate) => candidate.name === wanted);
  if (!root) return null;
  return resolveAccess(roots, grants, identity).find((entry) => entry.root.id === root.id) ?? null;
}

export function allowsWrite(mode: CloudAccessMode): boolean {
  return mode === "rw";
}

/** Refusal text an agent can act on: it names the boundary, not the internals. */
export function outsideGrantMessage(rootName: string): string {
  return `no access to folder "${rootName}": it is not granted to this agent`;
}

export function readOnlyMessage(rootName: string): string {
  return `folder "${rootName}" is granted read-only; writing is not allowed`;
}

/** Deterministic personal root: one folder per agent inside the account drive. */
export function personalRootName(agentId: string): string {
  return `agent-${agentId.toLowerCase()}`;
}

export function personalRootFolder(agentId: string): string {
  return `Agents/${agentId}`;
}

// -- the reserved `personal` alias -------------------------------------------
//
// An agent never has to be told its own folder name: `personal` always means
// it. The texts below are what the agent reads when the connector cannot work
// out which folder that is, so each one says what the agent or the owner has
// to do next instead of leaking connector internals.

export function personalRootUnknownCompanyMessage(): string {
  return `"${CLOUD_PERSONAL_ROOT_ALIAS}" needs the company this agent works for, and the connector could not tell; ask the owner for the folder name instead`;
}

export function personalRootNoAccountMessage(): string {
  return `"${CLOUD_PERSONAL_ROOT_ALIAS}" is not available yet: no cloud account is connected for this company, and the owner must connect one first`;
}

export function personalRootAmbiguousMessage(providerIds: readonly string[]): string {
  return `"${CLOUD_PERSONAL_ROOT_ALIAS}" is ambiguous here: this company has accounts for ${providerIds.join(", ")}, so ask the owner which folder is yours and use its name`;
}

export function reservedRootNameMessage(name: string): string {
  return `"${name}" is reserved: it always means the folder an agent gets for itself`;
}