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

import type {
  CloudAccessMode,
  CloudGrant,
  CloudGrantTargetKind,
  CloudResolvedAccess,
  CloudRoot,
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