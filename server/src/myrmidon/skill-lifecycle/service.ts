// myrmidon(1.6-SKILL-LIFE): the lifecycle service.
//
// Transitions: promote (candidate/deprecated → verified, needs an approved
// approval), deprecate (anything → deprecated), rollback (verified pointer back
// to the previous verified revision), and a delivery projection that the bot
// profile compiler reads. Every mutation appends a history event and an
// activity-log row, so the UI can show who approved what and when.

import {
  assertPromotionApproval,
  decideSkillDelivery,
  nextPromotionFields,
  nextRollbackFields,
  readSkillPilotAgents,
  rollbackTargetVersionId,
  SkillLifecycleError,
  type SkillDeliveryState,
  type SkillLifecycleEvent,
  type SkillLifecycleRecord,
  type SkillLifecycleState,
} from "./domain.js";
import type { SkillLifecycleSkillRef, SkillLifecycleStore } from "./store.js";

export interface SkillLifecycleActor {
  actorType: "agent" | "user" | "system";
  actorId: string | null;
}

export interface SkillLifecycleActivityEntry {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export interface SkillLifecycleServiceDeps {
  store: SkillLifecycleStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logActivity?: (entry: SkillLifecycleActivityEntry) => Promise<void>;
}

export interface SkillLifecycleView {
  skillId: string;
  key: string;
  name: string;
  slug: string;
  state: SkillLifecycleState;
  /** True when the skill has no lifecycle row yet and keeps legacy delivery. */
  implicit: boolean;
  currentVersionId: string | null;
  verifiedVersionId: string | null;
  previousVerifiedVersionId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reason: string | null;
  updatedAt: string | null;
  verifiedRevisionNumber: number | null;
}

export interface SkillLifecycleDelivery {
  /** Skill keys this agent must not receive at all. */
  blockedKeys: Set<string>;
  /** Skill key → revision id the lifecycle pins for delivery. */
  pinnedVersions: Map<string, string>;
  /** Why each blocked key is blocked, for the profile warnings. */
  reasons: Map<string, string>;
}

export interface SkillLifecycleService {
  list(companyId: string): Promise<SkillLifecycleView[]>;
  state(companyId: string, skillId: string): Promise<SkillLifecycleView>;
  history(companyId: string, skillId: string): Promise<SkillLifecycleEvent[]>;
  setCandidate(companyId: string, skillId: string, actor: SkillLifecycleActor): Promise<SkillLifecycleView>;
  promote(
    companyId: string,
    skillId: string,
    input: { approvalId: string; actor: SkillLifecycleActor },
  ): Promise<SkillLifecycleView>;
  deprecate(
    companyId: string,
    skillId: string,
    input: { reason?: string | null; actor: SkillLifecycleActor },
  ): Promise<SkillLifecycleView>;
  rollback(companyId: string, skillId: string, actor: SkillLifecycleActor): Promise<SkillLifecycleView>;
  /** The revision currently delivered for a skill (verified pointer, else current). */
  verifiedContent(
    companyId: string,
    skillId: string,
  ): Promise<{ versionId: string; revisionNumber: number; files: Array<{ path: string; content: string }> } | null>;
  resolveDelivery(companyId: string, agentId: string): Promise<SkillLifecycleDelivery>;
}

function actorIdOf(actor: SkillLifecycleActor): string {
  return actor.actorId ?? actor.actorType;
}

export function createSkillLifecycleService(deps: SkillLifecycleServiceDeps): SkillLifecycleService {
  const store = deps.store;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  async function requireSkill(companyId: string, skillId: string): Promise<SkillLifecycleSkillRef> {
    const skill = await store.getSkill(companyId, skillId);
    if (!skill) throw new SkillLifecycleError("skill_not_found", "Skill not found");
    return skill;
  }

  async function recordActivity(entry: SkillLifecycleActivityEntry): Promise<void> {
    if (!deps.logActivity) return;
    try {
      await deps.logActivity(entry);
    } catch {
      // The audit row must never fail a lifecycle transition that already
      // happened; the history event is the durable record either way.
    }
  }

  function viewOf(
    skill: SkillLifecycleSkillRef,
    record: SkillLifecycleRecord | null,
    verifiedRevisionNumber: number | null,
  ): SkillLifecycleView {
    return {
      skillId: skill.id,
      key: skill.key,
      name: skill.name,
      slug: skill.slug,
      // No row: legacy/unmanaged, delivered to everyone, shown as verified.
      state: record?.state ?? "verified",
      implicit: record === null,
      currentVersionId: skill.currentVersionId,
      verifiedVersionId: record?.verifiedVersionId ?? null,
      previousVerifiedVersionId: record?.previousVerifiedVersionId ?? null,
      approvedBy: record?.approvedBy ?? null,
      approvedAt: record?.approvedAt ?? null,
      reason: record?.reason ?? null,
      updatedAt: record?.updatedAt ?? null,
      verifiedRevisionNumber,
    };
  }

  async function revisionNumber(companyId: string, skillId: string, versionId: string | null): Promise<number | null> {
    if (!versionId) return null;
    const version = await store.getVersion(companyId, skillId, versionId);
    return version?.revisionNumber ?? null;
  }

  async function viewFor(companyId: string, skill: SkillLifecycleSkillRef): Promise<SkillLifecycleView> {
    const record = await store.getRecord(companyId, skill.id);
    return viewOf(skill, record, await revisionNumber(companyId, skill.id, record?.verifiedVersionId ?? null));
  }

  async function appendEvent(
    companyId: string,
    skillId: string,
    from: SkillLifecycleState | null,
    to: SkillLifecycleState,
    actor: SkillLifecycleActor,
    extra: { versionId?: string | null; approvalId?: string | null; reason?: string | null } = {},
  ): Promise<void> {
    await store.appendEvent({
      companyId,
      skillId,
      fromState: from,
      toState: to,
      versionId: extra.versionId ?? null,
      actorType: actor.actorType,
      actorId: actor.actorId,
      approvalId: extra.approvalId ?? null,
      reason: extra.reason ?? null,
    });
  }

  return {
    async list(companyId) {
      const [skills, records] = await Promise.all([store.listSkills(companyId), store.listRecords(companyId)]);
      const byId = new Map(records.map((record) => [record.skillId, record] as const));
      const out: SkillLifecycleView[] = [];
      for (const skill of skills) {
        const record = byId.get(skill.id) ?? null;
        out.push(viewOf(skill, record, await revisionNumber(companyId, skill.id, record?.verifiedVersionId ?? null)));
      }
      return out;
    },

    async state(companyId, skillId) {
      return viewFor(companyId, await requireSkill(companyId, skillId));
    },

    async history(companyId, skillId) {
      await requireSkill(companyId, skillId);
      return store.listEvents(companyId, skillId);
    },

    async setCandidate(companyId, skillId, actor) {
      const skill = await requireSkill(companyId, skillId);
      const existing = await store.getRecord(companyId, skill.id);
      const timestamp = now();
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        state: "candidate",
        verifiedVersionId: existing?.verifiedVersionId ?? null,
        previousVerifiedVersionId: existing?.previousVerifiedVersionId ?? null,
        approvedBy: existing?.approvedBy ?? null,
        approvedAt: existing?.approvedAt ?? null,
        reason: existing?.reason ?? null,
        updatedAt: timestamp.toISOString(),
      });
      await appendEvent(companyId, skill.id, existing?.state ?? null, "candidate", actor, {
        versionId: saved.verifiedVersionId,
        reason: "registered as a candidate",
      });
      await recordActivity({
        companyId,
        actorType: actor.actorType,
        actorId: actorIdOf(actor),
        action: "skill.lifecycle_candidate",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key },
      });
      return viewOf(skill, saved, await revisionNumber(companyId, skill.id, saved.verifiedVersionId));
    },

    async promote(companyId, skillId, input) {
      const skill = await requireSkill(companyId, skillId);
      const approval = await store.getApproval(input.approvalId);
      const approved = assertPromotionApproval(approval, skill.id);
      const versionId = skill.currentVersionId;
      if (!versionId) {
        throw new SkillLifecycleError("promotion_no_version", "The skill has no version to promote.");
      }
      const existing = await store.getRecord(companyId, skill.id);
      const timestamp = now();
      const fields = nextPromotionFields(existing, versionId, approved, timestamp);
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        verifiedVersionId: fields.verifiedVersionId,
        previousVerifiedVersionId: fields.previousVerifiedVersionId,
        approvedBy: fields.approvedBy,
        approvedAt: fields.approvedAt,
        reason: fields.reason,
        state: fields.state,
        updatedAt: timestamp.toISOString(),
      });
      await appendEvent(companyId, skill.id, existing?.state ?? null, "verified", input.actor, {
        versionId,
        approvalId: approved.id,
      });
      await recordActivity({
        companyId,
        actorType: input.actor.actorType,
        actorId: actorIdOf(input.actor),
        action: "skill.lifecycle_promoted",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key, versionId, approvalId: approved.id },
      });
      return viewOf(skill, saved, await revisionNumber(companyId, skill.id, saved.verifiedVersionId));
    },

    async deprecate(companyId, skillId, input) {
      const skill = await requireSkill(companyId, skillId);
      const existing = await store.getRecord(companyId, skill.id);
      const timestamp = now();
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        state: "deprecated",
        verifiedVersionId: existing?.verifiedVersionId ?? null,
        previousVerifiedVersionId: existing?.previousVerifiedVersionId ?? null,
        approvedBy: existing?.approvedBy ?? null,
        approvedAt: existing?.approvedAt ?? null,
        reason: input.reason ?? null,
        updatedAt: timestamp.toISOString(),
      });
      await appendEvent(companyId, skill.id, existing?.state ?? null, "deprecated", input.actor, {
        versionId: saved.verifiedVersionId,
        reason: input.reason ?? null,
      });
      await recordActivity({
        companyId,
        actorType: input.actor.actorType,
        actorId: actorIdOf(input.actor),
        action: "skill.lifecycle_deprecated",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key, reason: input.reason ?? null },
      });
      return viewOf(skill, saved, await revisionNumber(companyId, skill.id, saved.verifiedVersionId));
    },

    async rollback(companyId, skillId, actor) {
      const skill = await requireSkill(companyId, skillId);
      const existing = await store.getRecord(companyId, skill.id);
      if (!existing) {
        throw new SkillLifecycleError("rollback_no_verified_version", "The skill has no lifecycle record to roll back.");
      }
      const target = rollbackTargetVersionId(existing);
      const version = await store.getVersion(companyId, skill.id, target);
      if (!version) {
        throw new SkillLifecycleError("rollback_target_missing", "The previous verified version no longer exists.");
      }
      const timestamp = now();
      const fields = nextRollbackFields(existing);
      const saved = await store.saveRecord({
        skillId: skill.id,
        companyId,
        state: fields.state,
        verifiedVersionId: fields.verifiedVersionId,
        previousVerifiedVersionId: fields.previousVerifiedVersionId,
        approvedBy: existing.approvedBy,
        approvedAt: existing.approvedAt,
        reason: fields.reason,
        updatedAt: timestamp.toISOString(),
      });
      // The delivery path reads the skill's current version, so a rollback must
      // move it too — otherwise the restored content is the pointer's only.
      await store.setSkillCurrentVersion(companyId, skill.id, target);
      await appendEvent(companyId, skill.id, existing.state, saved.state, actor, {
        versionId: target,
        reason: `rolled back to revision ${version.revisionNumber}`,
      });
      await recordActivity({
        companyId,
        actorType: actor.actorType,
        actorId: actorIdOf(actor),
        action: "skill.lifecycle_rolled_back",
        entityType: "company_skill",
        entityId: skill.id,
        details: { skillKey: skill.key, versionId: target, revisionNumber: version.revisionNumber },
      });
      return viewOf({ ...skill, currentVersionId: target }, saved, version.revisionNumber);
    },

    async verifiedContent(companyId, skillId) {
      const skill = await requireSkill(companyId, skillId);
      const record = await store.getRecord(companyId, skill.id);
      const versionId = record?.verifiedVersionId ?? skill.currentVersionId;
      if (!versionId) return null;
      const version = await store.getVersion(companyId, skill.id, versionId);
      if (!version) return null;
      return {
        versionId,
        revisionNumber: version.revisionNumber,
        files: version.fileInventory.map((entry) => ({ path: entry.path, content: entry.content })),
      };
    },

    async resolveDelivery(companyId, agentId) {
      const [skills, records] = await Promise.all([store.listSkills(companyId), store.listRecords(companyId)]);
      const byId = new Map(records.map((record) => [record.skillId, record] as const));
      const pilotAgentIds = readSkillPilotAgents(env);
      const delivery: SkillLifecycleDelivery = { blockedKeys: new Set(), pinnedVersions: new Map(), reasons: new Map() };
      for (const skill of skills) {
        const record = byId.get(skill.id) ?? null;
        const state: SkillDeliveryState | null = record
          ? { state: record.state, verifiedVersionId: record.verifiedVersionId }
          : null;
        const decision = decideSkillDelivery({ skillKey: skill.key, agentId, lifecycle: state, pilotAgentIds });
        if (decision.blocked) {
          delivery.blockedKeys.add(skill.key);
          if (decision.reason) delivery.reasons.set(skill.key, decision.reason);
          continue;
        }
        if (decision.pinnedVersionId) delivery.pinnedVersions.set(skill.key, decision.pinnedVersionId);
      }
      return delivery;
    },
  };
}