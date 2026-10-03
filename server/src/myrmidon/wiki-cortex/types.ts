// server/src/myrmidon/wiki-cortex/types.ts
//
// myrmidon(1.6-WIKI): the shapes of a company regulation page.
//
// The contract the rest of the board reads is `ApprovedRegulation`: the newest
// approved revision of a page whose roles include the asking role. Everything
// else here is the wiki side of the lifecycle.

export type RegulationStatus = "draft" | "approved";

/** The role key meaning "every role of the company". */
export const ANY_ROLE = "*";

export interface RegulationRevisionRecord {
  revisionNumber: number;
  title: string;
  roles: string[];
  content: string;
  status: RegulationStatus;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface RegulationPageRecord {
  id: string;
  companyId: string;
  slug: string;
  title: string;
  roles: string[];
  status: RegulationStatus;
  revisionNumber: number;
  content: string;
  revisions: RegulationRevisionRecord[];
  createdAt: Date;
  updatedAt: Date;
}

/** Who writes a revision; the wiki records it, the board decides who may. */
export interface RegulationActor {
  agentId?: string | null;
  userId?: string | null;
}

/**
 * One approved regulation as the delivery path sees it. `version` is the
 * revision number the text came from, so a run can tell which text it read.
 */
export interface ApprovedRegulation {
  pageId: string;
  slug: string;
  title: string;
  content: string;
  version: number;
  roles: string[];
}