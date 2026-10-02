// server/src/myrmidon/agent-instructions-revisions/service.ts
//
// myrmidon(H2): revision history for an agent's instructions bundle.
//
// The instructions themselves keep living in the file bundle the board already
// reads and writes (agent-instructions.ts, managed root) and keep traveling to
// the model in the run request body (W2a/G4) — those paths are unchanged. What
// this module adds is the single durable history: every change to the bundle
// (file put, file delete, bundle patch, rollback) is snapshotted into
// `agent_instructions_revisions` with the whole file set, so any earlier
// revision can be restored with one call and the next run of the agent picks
// the restored files up exactly the way it picks up any edit.
//
// Design notes:
// - A revision snapshots the WHOLE bundle, not a delta: the rollback must not
//   depend on the current state being what the editor thinks it is.
// - Revision numbers are allocated in a transaction with a row lock on the
//   agent (select ... for update), the same pattern company-skills uses, so two
//   concurrent edits cannot take the same number.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentInstructionsRevisions,
  agents,
  type AgentInstructionsRevisionFile,
  type Db,
} from "@paperclipai/db";

export const INSTRUCTIONS_REVISION_ROLLBACK_ACTION = "agent.instructions_revision_rollback";

export type AgentInstructionsRevisionSource =
  | "instructions_bundle_file_put"
  | "instructions_bundle_file_delete"
  | "instructions_bundle_patch"
  | "instructions_path_patch"
  | "rollback";

export interface AgentInstructionsRevisionActor {
  createdByAgentId: string | null;
  createdByUserId: string | null;
}

export interface AgentInstructionsRevisionRecord {
  id: string;
  companyId: string;
  agentId: string;
  revisionNumber: number;
  entryFile: string;
  files: AgentInstructionsRevisionFile[];
  changedFiles: string[];
  source: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  rolledBackFromRevisionId: string | null;
  createdAt: Date;
}

/**
 * Records one revision of the agent's instructions bundle from a known file
 * set (the caller just wrote it). Returns the created record or null when the
 * file set is empty.
 */
export async function recordAgentInstructionsRevision(
  db: Db,
  agent: { id: string; companyId: string },
  input: {
    source: AgentInstructionsRevisionSource;
    files: Record<string, string>;
    entryFile: string;
    changedFiles?: string[];
    actor?: AgentInstructionsRevisionActor;
    rolledBackFromRevisionId?: string | null;
  },
): Promise<AgentInstructionsRevisionRecord | null> {
  const files: AgentInstructionsRevisionFile[] = Object.entries(input.files)
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (files.length === 0) return null;

  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`
      select ${agents.id}
      from ${agents}
      where ${agents.id} = ${agent.id}
        and ${agents.companyId} = ${agent.companyId}
      for update
    `);
    const [{ nextRevision }] = await tx
      .select({
        nextRevision: sql<number>`coalesce(max(${agentInstructionsRevisions.revisionNumber}), 0) + 1`,
      })
      .from(agentInstructionsRevisions)
      .where(
        and(
          eq(agentInstructionsRevisions.companyId, agent.companyId),
          eq(agentInstructionsRevisions.agentId, agent.id),
        ),
      );
    const inserted = await tx
      .insert(agentInstructionsRevisions)
      .values({
        companyId: agent.companyId,
        agentId: agent.id,
        revisionNumber: Number(nextRevision ?? 1),
        entryFile: input.entryFile,
        files,
        changedFiles: input.changedFiles ?? files.map((file) => file.path),
        source: input.source,
        createdByAgentId: input.actor?.createdByAgentId ?? null,
        createdByUserId: input.actor?.createdByUserId ?? null,
        rolledBackFromRevisionId: input.rolledBackFromRevisionId ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return inserted;
  });
  return row ? toRecord(row) : null;
}

export function listAgentInstructionsRevisions(
  db: Db,
  agent: { id: string; companyId: string },
  options?: { limit?: number },
): Promise<AgentInstructionsRevisionRecord[]> {
  const limit = options?.limit ?? 50;
  return db
    .select()
    .from(agentInstructionsRevisions)
    .where(
      and(
        eq(agentInstructionsRevisions.companyId, agent.companyId),
        eq(agentInstructionsRevisions.agentId, agent.id),
      ),
    )
    .orderBy(desc(agentInstructionsRevisions.revisionNumber))
    .limit(limit)
    .then((rows) => rows.map(toRecord));
}

export function getAgentInstructionsRevision(
  db: Db,
  agent: { id: string; companyId: string },
  revisionId: string,
): Promise<AgentInstructionsRevisionRecord | null> {
  return db
    .select()
    .from(agentInstructionsRevisions)
    .where(
      and(
        eq(agentInstructionsRevisions.companyId, agent.companyId),
        eq(agentInstructionsRevisions.agentId, agent.id),
        eq(agentInstructionsRevisions.id, revisionId),
      ),
    )
    .then((rows) => (rows[0] ? toRecord(rows[0]) : null));
}

export function toRecord(
  row: typeof agentInstructionsRevisions.$inferSelect,
): AgentInstructionsRevisionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    revisionNumber: row.revisionNumber,
    entryFile: row.entryFile,
    files: row.files ?? [],
    changedFiles: row.changedFiles ?? [],
    source: row.source,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    rolledBackFromRevisionId: row.rolledBackFromRevisionId,
    createdAt: row.createdAt,
  };
}
