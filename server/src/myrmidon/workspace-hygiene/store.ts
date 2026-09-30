import { and, asc, desc, eq, gt, isNotNull, lte, or, sql } from "drizzle-orm";
import { activityLog, executionWorkspaces, type Db } from "@paperclipai/db";
import { WORKSPACE_HYGIENE_METADATA_KEY } from "@paperclipai/shared";

/**
 * Database port of the workspace hygiene sweep (myrmidon WORKSPACE-HYGIENE,
 * part C).
 *
 * The sweep itself (sweep.ts) and its tests work against this interface, so the
 * rotation, the measurement, the metadata write and the signal are all provable
 * without a database. Everything that knows about drizzle lives here.
 */

export interface WorkspaceHygieneWorkspaceRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  providerType: string;
  cwd: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
}

/** Position of the rotation: the last row of the previous page. */
export interface WorkspaceHygieneCursor {
  updatedAt: Date;
  id: string;
}

export interface WorkspaceHygieneStore {
  /**
   * The next page of workspaces to measure, in a stable `(updatedAt, id)` order.
   * `boundary` freezes the upper bound at the start of a rotation, so a stream
   * of newer rows cannot keep every page full and the cursor always reaches the
   * end. A page shorter than `limit` means the rotation finished.
   */
  listPage(input: {
    cursor: WorkspaceHygieneCursor | null;
    boundary: Date;
    limit: number;
  }): Promise<WorkspaceHygieneWorkspaceRow[]>;
  /** Every workspace that carries a measurement record, for the current totals. */
  listMeasured(limit: number): Promise<WorkspaceHygieneWorkspaceRow[]>;
  /** Write the measurement into the workspace metadata, keeping every other key. */
  saveMetadata(workspaceId: string, metadata: Record<string, unknown>): Promise<void>;
  /** When this action was last written for the company, or null. */
  lastActivityAt(companyId: string, action: string): Promise<Date | null>;
}

/**
 * The selected columns, built per call rather than once at import time: a test
 * that mocks `@paperclipai/db` with only the exports it needs (the server
 * startup test does) must be able to import this module without the mock
 * failing on a missing table. Reading `executionWorkspaces` at module scope
 * made that import throw.
 */
function rowColumns() {
  return {
    id: executionWorkspaces.id,
    companyId: executionWorkspaces.companyId,
    name: executionWorkspaces.name,
    status: executionWorkspaces.status,
    providerType: executionWorkspaces.providerType,
    cwd: executionWorkspaces.cwd,
    metadata: executionWorkspaces.metadata,
    updatedAt: executionWorkspaces.updatedAt,
  };
}

type WorkspaceHygieneRowSelection = ReturnType<typeof rowColumns>;

function toRow(row: WorkspaceHygieneRowSelection): WorkspaceHygieneWorkspaceRow {
  return row as WorkspaceHygieneWorkspaceRow;
}

export function createDbWorkspaceHygieneStore(db: Db): WorkspaceHygieneStore {
  return {
    listPage: async ({ cursor, boundary, limit }) => {
      const cursorFilter = cursor
        ? or(
            gt(executionWorkspaces.updatedAt, cursor.updatedAt),
            and(
              eq(executionWorkspaces.updatedAt, cursor.updatedAt),
              gt(executionWorkspaces.id, cursor.id),
            ),
          )
        : undefined;
      const rows = await db
        .select(rowColumns())
        .from(executionWorkspaces)
        .where(
          and(
            // A workspace without a local directory has nothing to measure: a
            // managed sandbox elsewhere is not on this host's disk.
            isNotNull(executionWorkspaces.cwd),
            lte(executionWorkspaces.updatedAt, boundary),
            cursorFilter,
          ),
        )
        .orderBy(asc(executionWorkspaces.updatedAt), asc(executionWorkspaces.id))
        .limit(limit);
      return rows.map(toRow);
    },

    listMeasured: async (limit) => {
      const rows = await db
        .select(rowColumns())
        .from(executionWorkspaces)
        .where(
          sql`${executionWorkspaces.metadata} -> ${WORKSPACE_HYGIENE_METADATA_KEY} IS NOT NULL`,
        )
        .orderBy(asc(executionWorkspaces.updatedAt), asc(executionWorkspaces.id))
        .limit(limit);
      return rows.map(toRow);
    },

    saveMetadata: async (workspaceId, metadata) => {
      await db
        .update(executionWorkspaces)
        .set({ metadata, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspaceId));
    },

    lastActivityAt: async (companyId, action) => {
      const [row] = await db
        .select({ createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)))
        .orderBy(desc(activityLog.createdAt))
        .limit(1);
      return row?.createdAt ?? null;
    },
  };
}