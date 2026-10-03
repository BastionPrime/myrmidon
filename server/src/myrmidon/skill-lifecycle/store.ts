// myrmidon(1.6-SKILL-LIFE): the database side of the lifecycle.
//
// Everything the service needs is behind `SkillLifecycleStore`, so the state
// machine, the approval gate and the rollback are tested without a database
// and the SQL lives in one place. Nothing here writes to a vendor table except
// `setSkillCurrentVersion`, which moves the skill's `current_version_id` to the
// revision a rollback restored (that pointer is what the delivery path reads).

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  companySkillLifecycle,
  companySkillLifecycleEvents,
  companySkillVersions,
  companySkills,
} from "@paperclipai/db";
import type {
  SkillLifecycleApprovalRef,
  SkillLifecycleEvent,
  SkillLifecycleRecord,
  SkillLifecycleState,
} from "./domain.js";
import { isSkillLifecycleState } from "./domain.js";

export interface SkillLifecycleSkillRef {
  id: string;
  key: string;
  name: string;
  slug: string;
  currentVersionId: string | null;
}

export interface SkillLifecycleVersionRef {
  id: string;
  revisionNumber: number;
  fileInventory: Array<{ path: string; kind?: string; content: string }>;
}

export interface SkillLifecycleStore {
  getSkill(companyId: string, skillId: string): Promise<SkillLifecycleSkillRef | null>;
  listSkills(companyId: string): Promise<SkillLifecycleSkillRef[]>;
  getRecord(companyId: string, skillId: string): Promise<SkillLifecycleRecord | null>;
  listRecords(companyId: string): Promise<SkillLifecycleRecord[]>;
  saveRecord(record: SkillLifecycleRecord): Promise<SkillLifecycleRecord>;
  appendEvent(
    event: Omit<SkillLifecycleEvent, "id" | "createdAt"> & { companyId: string; createdAt?: string },
  ): Promise<SkillLifecycleEvent>;
  listEvents(companyId: string, skillId: string): Promise<SkillLifecycleEvent[]>;
  getVersion(companyId: string, skillId: string, versionId: string): Promise<SkillLifecycleVersionRef | null>;
  getApproval(approvalId: string): Promise<SkillLifecycleApprovalRef | null>;
  setSkillCurrentVersion(companyId: string, skillId: string, versionId: string | null): Promise<void>;
}

function toRecord(row: typeof companySkillLifecycle.$inferSelect): SkillLifecycleRecord {
  const state: SkillLifecycleState = isSkillLifecycleState(row.state) ? row.state : "candidate";
  return {
    skillId: row.skillId,
    companyId: row.companyId,
    state,
    verifiedVersionId: row.verifiedVersionId ?? null,
    previousVerifiedVersionId: row.previousVerifiedVersionId ?? null,
    approvedBy: row.approvedBy ?? null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    reason: row.reason ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: typeof companySkillLifecycleEvents.$inferSelect): SkillLifecycleEvent {
  return {
    id: row.id,
    skillId: row.skillId,
    fromState: isSkillLifecycleState(row.fromState) ? row.fromState : null,
    toState: isSkillLifecycleState(row.toState) ? row.toState : "candidate",
    versionId: row.versionId ?? null,
    actorType: (row.actorType === "agent" || row.actorType === "user" ? row.actorType : "system"),
    actorId: row.actorId ?? null,
    approvalId: row.approvalId ?? null,
    reason: row.reason ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDbSkillLifecycleStore(db: Db): SkillLifecycleStore {
  return {
    async getSkill(companyId, skillId) {
      const row = await db
        .select({
          id: companySkills.id,
          key: companySkills.key,
          name: companySkills.name,
          slug: companySkills.slug,
          currentVersionId: companySkills.currentVersionId,
        })
        .from(companySkills)
        .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, skillId)))
        .then((rows) => rows[0] ?? null);
      return row ? { ...row, currentVersionId: row.currentVersionId ?? null } : null;
    },

    async listSkills(companyId) {
      const rows = await db
        .select({
          id: companySkills.id,
          key: companySkills.key,
          name: companySkills.name,
          slug: companySkills.slug,
          currentVersionId: companySkills.currentVersionId,
        })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId))
        .orderBy(asc(companySkills.name));
      return rows.map((row) => ({ ...row, currentVersionId: row.currentVersionId ?? null }));
    },

    async getRecord(companyId, skillId) {
      const row = await db
        .select()
        .from(companySkillLifecycle)
        .where(and(eq(companySkillLifecycle.companyId, companyId), eq(companySkillLifecycle.skillId, skillId)))
        .then((rows) => rows[0] ?? null);
      return row ? toRecord(row) : null;
    },

    async listRecords(companyId) {
      const rows = await db
        .select()
        .from(companySkillLifecycle)
        .where(eq(companySkillLifecycle.companyId, companyId));
      return rows.map(toRecord);
    },

    async saveRecord(record) {
      const values = {
        companyId: record.companyId,
        skillId: record.skillId,
        state: record.state,
        verifiedVersionId: record.verifiedVersionId,
        previousVerifiedVersionId: record.previousVerifiedVersionId,
        approvedBy: record.approvedBy,
        approvedAt: record.approvedAt ? new Date(record.approvedAt) : null,
        reason: record.reason,
        updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
      };
      const row = await db
        .insert(companySkillLifecycle)
        .values(values)
        .onConflictDoUpdate({
          target: [companySkillLifecycle.companyId, companySkillLifecycle.skillId],
          set: {
            state: values.state,
            verifiedVersionId: values.verifiedVersionId,
            previousVerifiedVersionId: values.previousVerifiedVersionId,
            approvedBy: values.approvedBy,
            approvedAt: values.approvedAt,
            reason: values.reason,
            updatedAt: values.updatedAt,
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw new Error("Failed to persist the skill lifecycle row.");
      return toRecord(row);
    },

    async appendEvent(event) {
      const row = await db
        .insert(companySkillLifecycleEvents)
        .values({
          companyId: event.companyId,
          skillId: event.skillId,
          fromState: event.fromState,
          toState: event.toState,
          versionId: event.versionId,
          actorType: event.actorType,
          actorId: event.actorId,
          approvalId: event.approvalId,
          reason: event.reason,
          ...(event.createdAt ? { createdAt: new Date(event.createdAt) } : {}),
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw new Error("Failed to persist the skill lifecycle event.");
      return toEvent(row);
    },

    async listEvents(companyId, skillId) {
      const rows = await db
        .select()
        .from(companySkillLifecycleEvents)
        .where(
          and(eq(companySkillLifecycleEvents.companyId, companyId), eq(companySkillLifecycleEvents.skillId, skillId)),
        )
        .orderBy(desc(companySkillLifecycleEvents.createdAt));
      return rows.map(toEvent);
    },

    async getVersion(companyId, skillId, versionId) {
      const row = await db
        .select({
          id: companySkillVersions.id,
          revisionNumber: companySkillVersions.revisionNumber,
          fileInventory: companySkillVersions.fileInventory,
        })
        .from(companySkillVersions)
        .where(
          and(
            eq(companySkillVersions.companyId, companyId),
            eq(companySkillVersions.companySkillId, skillId),
            eq(companySkillVersions.id, versionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        id: row.id,
        revisionNumber: row.revisionNumber,
        fileInventory: (row.fileInventory ?? []).map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          content: entry.content,
        })),
      };
    },

    async getApproval(approvalId) {
      const row = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        status: row.status,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        decidedByUserId: row.decidedByUserId ?? null,
        decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      };
    },

    async setSkillCurrentVersion(companyId, skillId, versionId) {
      await db
        .update(companySkills)
        .set({ currentVersionId: versionId, updatedAt: new Date() })
        .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, skillId)));
    },
  };
}