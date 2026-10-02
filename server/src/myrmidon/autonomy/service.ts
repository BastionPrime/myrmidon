// myrmidon(1.6-AUTONOMY): the autonomy service — read/write the matrix, the
// regulations with draft → approved revisions, and the change log.
//
// The service owns the domain rules and takes its storage seam by injection
// (`AutonomyStore`), so the same code is used in production over
// instance_settings and in tests over an in-memory document. It never throws
// HTTP errors itself: the route layer maps the typed results below onto status
// codes. That split is what lets the resolver and the revision model be tested
// without a database.

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog } from "@paperclipai/db";
import {
  defaultAutonomyMatrix,
  type AutonomyActionClass,
  type AutonomyActorRef,
  type AutonomyChangeAction,
  type AutonomyChangeLogEntry,
  type AutonomyMatrix,
  type AutonomyMatrixPatch,
  type AutonomyRegulation,
  type AutonomyRegulationRevision,
  type AutonomySnapshot,
} from "@paperclipai/shared";
import {
  AUTONOMY_REVISION_LIMIT,
  type AutonomyDocument,
  type AutonomyStore,
} from "./store.js";

/** The activity-log source every autonomy mutation is written under. */
export const AUTONOMY_ACTIVITY_SOURCE = "myrmidon.autonomy";
export const AUTONOMY_CHANGE_LOG_LIMIT = 100;

/** A typed refusal the route layer turns into 409 / 404 / 422. */
export type AutonomyFailure =
  | { kind: "version_conflict"; expectedVersion: number; actualVersion: number }
  | { kind: "regulation_not_found"; regulationId: string }
  | { kind: "revision_not_found"; regulationId: string; revision: number }
  | { kind: "already_approved"; regulationId: string }
  | { kind: "not_approved"; regulationId: string };

export type AutonomyResult<T> = { ok: true; value: T } | { ok: false; failure: AutonomyFailure };

function ok<T>(value: T): AutonomyResult<T> {
  return { ok: true, value };
}

function fail<T>(failure: AutonomyFailure): AutonomyResult<T> {
  return { ok: false, failure };
}

/** The shape of one change-log row as stored in `activity_log.details`. */
interface AutonomyChangeDetails {
  summary?: unknown;
  matrixVersion?: unknown;
  regulationId?: unknown;
  action?: unknown;
}

function changeLogEntry(
  id: string,
  at: string,
  actor: AutonomyActorRef,
  action: AutonomyChangeAction,
  details: AutonomyChangeDetails,
): AutonomyChangeLogEntry {
  return {
    id,
    at,
    actor,
    action,
    summary: typeof details.summary === "string" ? details.summary : "",
    matrixVersion: typeof details.matrixVersion === "number" ? details.matrixVersion : null,
    regulationId: typeof details.regulationId === "string" ? details.regulationId : null,
  };
}

export interface AutonomyServiceDeps {
  store: AutonomyStore;
  /** Writes the audit row. Production passes the activity-log service; tests pass a recorder. */
  logActivity(input: {
    companyId: string;
    actorType: "agent" | "user" | "system";
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }): Promise<void>;
  /** Returns the change log, newest first. */
  listChangeLog(companyId: string, limit: number): Promise<AutonomyChangeLogEntry[]>;
  now(): Date;
  newId(): string;
}

export function autonomyService(deps: AutonomyServiceDeps) {
  const now = () => deps.now().toISOString();

  function cloneDocument(document: AutonomyDocument): AutonomyDocument {
    return JSON.parse(JSON.stringify(document)) as AutonomyDocument;
  }

  async function snapshot(companyId: string): Promise<AutonomySnapshot> {
    const document = await deps.store.read();
    const changeLog = await deps.listChangeLog(companyId, AUTONOMY_CHANGE_LOG_LIMIT);
    return { matrix: document.matrix, regulations: document.regulations, changeLog };
  }

  /** Replace the matrix rules and defaults, refusing a stale expected version. */
  async function updateMatrix(
    companyId: string,
    actor: AutonomyActorRef,
    patch: AutonomyMatrixPatch,
  ): Promise<AutonomyResult<AutonomyMatrix>> {
    const { result } = await deps.store.mutate<AutonomyResult<AutonomyMatrix>>((current) => {
      if (patch.expectedVersion !== undefined && patch.expectedVersion !== current.matrix.version) {
        return {
          next: null,
          result: fail({
            kind: "version_conflict",
            expectedVersion: patch.expectedVersion,
            actualVersion: current.matrix.version,
          }),
        };
      }
      const nextMatrix: AutonomyMatrix = {
        version: current.matrix.version + 1,
        rules: patch.rules.map((rule) => ({
          role: rule.role,
          actionClass: rule.actionClass,
          verdict: rule.verdict,
          agentId: rule.agentId ?? null,
        })),
        defaults: { ...patch.defaults },
      };
      const next: AutonomyDocument = { ...current, matrix: nextMatrix };
      return { next, result: ok(nextMatrix) };
    });
    if (!result.ok) return result;
    await deps.logActivity({
      companyId,
      actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
      actorId: actor.id,
      action: `${AUTONOMY_ACTIVITY_SOURCE}.matrix_edit`,
      entityType: "autonomy_matrix",
      entityId: companyId,
      details: {
        summary: `Matrix updated to version ${result.value.version} (${result.value.rules.length} rules).`,
        matrixVersion: result.value.version,
        action: "matrix_edit",
      },
    });
    return result;
  }

  async function createRegulation(
    companyId: string,
    actor: AutonomyActorRef,
    input: { role: string; title: string; bodyMarkdown: string },
  ): Promise<AutonomyResult<AutonomyRegulation>> {
    const id = deps.newId();
    const at = now();
    const regulation: AutonomyRegulation = {
      id,
      role: input.role,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      status: "draft",
      revision: 1,
      revisions: [
        { revision: 1, title: input.title, bodyMarkdown: input.bodyMarkdown, status: "draft", author: actor, at },
      ],
      createdAt: at,
      createdBy: actor,
      updatedAt: at,
      updatedBy: actor,
      supersededBy: null,
      wikiPageId: null,
    };
    await deps.store.mutate((current) => ({
      next: { ...current, regulations: [regulation, ...current.regulations] },
      result: null,
    }));
    await deps.logActivity({
      companyId,
      actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
      actorId: actor.id,
      action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_created`,
      entityType: "autonomy_regulation",
      entityId: id,
      details: {
        summary: `Regulation created for role ${input.role} (draft, revision 1).`,
        action: "regulation_created",
        regulationId: id,
      },
    });
    return ok(regulation);
  }

  /** Edit a regulation: always a new draft revision; an approved one drops back to draft. */
  async function updateRegulation(
    companyId: string,
    actor: AutonomyActorRef,
    input: { id: string; title?: string; bodyMarkdown?: string },
  ): Promise<AutonomyResult<AutonomyRegulation>> {
    const at = now();
    const { result } = await deps.store.mutate<AutonomyResult<AutonomyRegulation>>((current) => {
      const index = current.regulations.findIndex((entry) => entry.id === input.id);
      if (index === -1) return { next: null, result: fail({ kind: "regulation_not_found", regulationId: input.id }) };
      const existing = current.regulations[index]!;
      const title = input.title ?? existing.title;
      const bodyMarkdown = input.bodyMarkdown ?? existing.bodyMarkdown;
      const revision = existing.revision + 1;
      const draft: AutonomyRegulationRevision = {
        revision,
        title,
        bodyMarkdown,
        status: "draft",
        author: actor,
        at,
      };
      const updated: AutonomyRegulation = {
        ...existing,
        title,
        bodyMarkdown,
        status: "draft",
        revision,
        revisions: [...existing.revisions, draft].slice(-AUTONOMY_REVISION_LIMIT),
        updatedAt: at,
        updatedBy: actor,
      };
      const regulations = [...current.regulations];
      regulations[index] = updated;
      return { next: { ...current, regulations }, result: ok(updated) };
    });
    if (!result.ok) return result;
    await deps.logActivity({
      companyId,
      actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
      actorId: actor.id,
      action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_edited`,
      entityType: "autonomy_regulation",
      entityId: input.id,
      details: {
        summary: `Regulation revised to revision ${result.value.revision} (draft).`,
        action: "regulation_edited",
        regulationId: input.id,
      },
    });
    return result;
  }

  /** Promote the current draft of a regulation to approved. */
  async function approveRegulation(
    companyId: string,
    actor: AutonomyActorRef,
    regulationId: string,
  ): Promise<AutonomyResult<AutonomyRegulation>> {
    const at = now();
    const { result } = await deps.store.mutate<AutonomyResult<AutonomyRegulation>>((current) => {
      const index = current.regulations.findIndex((entry) => entry.id === regulationId);
      if (index === -1) return { next: null, result: fail({ kind: "regulation_not_found", regulationId }) };
      const existing = current.regulations[index]!;
      if (existing.status === "approved") return { next: null, result: fail({ kind: "already_approved", regulationId }) };
      const revisions = existing.revisions.map((entry) =>
        entry.revision === existing.revision ? { ...entry, status: "approved" as const } : entry,
      );
      const approvedRegulation: AutonomyRegulation = {
        ...existing,
        status: "approved",
        revisions,
        updatedAt: at,
        updatedBy: actor,
      };
      // Supersede any earlier approved regulation for the same role: only one
      // approved regulation per role is current, and the earlier one stays
      // retrievable so rollback can re-promote it.
      const regulations = current.regulations.map((entry, entryIndex) => {
        if (entryIndex === index) return approvedRegulation;
        if (entry.role === existing.role && entry.status === "approved") {
          return { ...entry, supersededBy: regulationId, updatedAt: at, updatedBy: actor };
        }
        return entry;
      });
      return { next: { ...current, regulations }, result: ok(approvedRegulation) };
    });
    if (!result.ok) return result;
    await deps.logActivity({
      companyId,
      actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
      actorId: actor.id,
      action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_approved`,
      entityType: "autonomy_regulation",
      entityId: regulationId,
      details: {
        summary: `Regulation approved for role ${result.value.role} at revision ${result.value.revision}.`,
        action: "regulation_approved",
        regulationId,
      },
    });
    return result;
  }

  /** Re-promote an earlier revision as a new approved revision (the rollback path). */
  async function restoreRegulationRevision(
    companyId: string,
    actor: AutonomyActorRef,
    input: { id: string; toRevision: number },
  ): Promise<AutonomyResult<AutonomyRegulation>> {
    const at = now();
    const { result } = await deps.store.mutate<AutonomyResult<AutonomyRegulation>>((current) => {
      const index = current.regulations.findIndex((entry) => entry.id === input.id);
      if (index === -1) return { next: null, result: fail({ kind: "regulation_not_found", regulationId: input.id }) };
      const existing = current.regulations[index]!;
      const source = existing.revisions.find((entry) => entry.revision === input.toRevision);
      if (!source) {
        return {
          next: null,
          result: fail({ kind: "revision_not_found", regulationId: input.id, revision: input.toRevision }),
        };
      }
      const revision = existing.revision + 1;
      const restored: AutonomyRegulationRevision = {
        revision,
        title: source.title,
        bodyMarkdown: source.bodyMarkdown,
        status: "approved",
        author: actor,
        at,
      };
      const regulations = [...current.regulations];
      regulations[index] = {
        ...existing,
        title: source.title,
        bodyMarkdown: source.bodyMarkdown,
        status: "approved",
        revision,
        revisions: [...existing.revisions, restored].slice(-AUTONOMY_REVISION_LIMIT),
        updatedAt: at,
        updatedBy: actor,
      };
      return { next: { ...current, regulations }, result: ok(regulations[index]!) };
    });
    if (!result.ok) return result;
    await deps.logActivity({
      companyId,
      actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
      actorId: actor.id,
      action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_rolled_back`,
      entityType: "autonomy_regulation",
      entityId: input.id,
      details: {
        summary: `Regulation rolled back to revision ${input.toRevision} (now revision ${result.value.revision}).`,
        action: "regulation_rolled_back",
        regulationId: input.id,
      },
    });
    return result;
  }

  /** Delete a regulation outright. Board-only at the route layer. */
  async function deleteRegulation(
    companyId: string,
    actor: AutonomyActorRef,
    regulationId: string,
  ): Promise<AutonomyResult<{ id: string }>> {
    const { result } = await deps.store.mutate<AutonomyResult<{ id: string }>>((current) => {
      const existing = current.regulations.find((entry) => entry.id === regulationId);
      if (!existing) return { next: null, result: fail({ kind: "regulation_not_found", regulationId }) };
      return {
        next: { ...current, regulations: current.regulations.filter((entry) => entry.id !== regulationId) },
        result: ok({ id: regulationId }),
      };
    });
    if (!result.ok) return result;
    await deps.logActivity({
      companyId,
      actorType: actor.type === "agent" ? "agent" : actor.type === "system" ? "system" : "user",
      actorId: actor.id,
      action: `${AUTONOMY_ACTIVITY_SOURCE}.regulation_deleted`,
      entityType: "autonomy_regulation",
      entityId: regulationId,
      details: { summary: "Regulation deleted.", action: "regulation_deleted", regulationId },
    });
    return result;
  }

  /** The stored matrix, creating the factory default on first read. */
  async function readMatrix(): Promise<AutonomyMatrix> {
    const document = await deps.store.read();
    return document.matrix ?? defaultAutonomyMatrix();
  }

  return {
    snapshot,
    readMatrix,
    updateMatrix,
    createRegulation,
    updateRegulation,
    approveRegulation,
    restoreRegulationRevision,
    deleteRegulation,
    // exposed for the route layer's tests
    _clone: cloneDocument,
  };
}

export type AutonomyService = ReturnType<typeof autonomyService>;

/** The real change log: our own `activity_log` rows, newest first. */
export function dbAutonomyChangeLog(db: Db) {
  return async (companyId: string, limit: number): Promise<AutonomyChangeLogEntry[]> => {
    const rows = await db
      .select({
        id: activityLog.id,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          sql`${activityLog.action} like ${`${AUTONOMY_ACTIVITY_SOURCE}.%`}`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
    return rows.map((row) => {
      const action = row.action.slice(`${AUTONOMY_ACTIVITY_SOURCE}.`.length);
      const details = (row.details ?? {}) as AutonomyChangeDetails;
      const actorType = row.actorType === "agent" ? "agent" : row.actorType === "system" ? "system" : "board";
      return changeLogEntry(
        row.id,
        row.createdAt.toISOString(),
        { type: actorType, id: row.actorId },
        (typeof details.action === "string" ? details.action : action) as AutonomyChangeAction,
        details,
      );
    });
  };
}