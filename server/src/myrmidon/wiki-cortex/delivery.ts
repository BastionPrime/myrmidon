// server/src/myrmidon/wiki-cortex/delivery.ts
//
// myrmidon(1.6-WIKI): how an approved regulation reaches an agent.
//
// The fleet runs in container bots whose profile is compiled on every reconcile
// tick (bot-containers/profile-compile.ts). The profile is where the rest of an
// agent's context already lands, so the approved regulations for the agent's
// role are delivered there as one extra workspace file. The compile is
// deterministic and its hash decides whether a bot restarts, so the file is
// built from the resolver alone: same approved revisions — same bytes — no
// restart; a newly approved revision changes the hash and the bot picks the new
// text up on its next run.
//
// A delivered file never overwrites the agent's own bundle: when the bundle
// already ships a REGULATIONS.md, that one wins and the compile reports why.

import { REGULATIONS_WORKSPACE_FILE, renderRegulationsMarkdown } from "./render.js";
import type { ApprovedRegulation } from "./types.js";

/** The shape the profile compiler takes for a workspace file. */
export interface RegulationWorkspaceFile {
  path: string;
  content: string;
}

/** Just the resolver half of the service, so delivery can be faked in tests. */
export interface RegulationResolver {
  resolved(companyId: string, role: string): Promise<ApprovedRegulation[]>;
}

export interface RegulationDeliveryTarget {
  companyId: string;
  /** The agent's role key; the fleet's agents default to `general`. */
  role?: string | null;
}

export const DEFAULT_AGENT_ROLE = "general";

export interface RegulationDelivery {
  files: RegulationWorkspaceFile[];
  warnings: string[];
}

/**
 * The workspace files an agent's profile gets from the wiki. No approved
 * regulation for the role means no file at all — an instance that never writes
 * a regulation keeps byte-identical profiles.
 */
export async function loadRegulationWorkspaceFiles(
  resolver: RegulationResolver,
  target: RegulationDeliveryTarget,
  options: { takenPaths?: readonly string[] } = {},
): Promise<RegulationDelivery> {
  const role = (target.role ?? "").trim() || DEFAULT_AGENT_ROLE;
  const regulations = await resolver.resolved(target.companyId, role);
  if (regulations.length === 0) return { files: [], warnings: [] };

  const taken = new Set((options.takenPaths ?? []).map((path) => path.toLowerCase()));
  if (taken.has(REGULATIONS_WORKSPACE_FILE.toLowerCase())) {
    return {
      files: [],
      warnings: [
        `regulations: the instructions bundle already contains ${REGULATIONS_WORKSPACE_FILE}; the wiki text was not delivered to this agent`,
      ],
    };
  }
  return {
    files: [{ path: REGULATIONS_WORKSPACE_FILE, content: renderRegulationsMarkdown(regulations) }],
    warnings: [],
  };
}