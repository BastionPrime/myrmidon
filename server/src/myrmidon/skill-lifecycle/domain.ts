// myrmidon(1.6-SKILL-LIFE): the pure part of the company-skill lifecycle.
//
// A company skill moves candidate → verified → deprecated. Only a verified
// version is delivered to agents by default; a candidate reaches the pilot
// agent set only; a deprecated skill reaches nobody. Promotion needs an
// approved approval of type `skill_promotion` (the existing approvals
// pipeline), so a candidate cannot become verified by itself. A rollback
// points `verifiedVersionId` back at the previous verified revision and the
// content is read from `company_skill_versions`.
//
// This file has no database and no Express: the state machine, the approval
// gate and the delivery decision are pure, and the store-bound service and the
// routes sit on top of them.

/** The states a skill can be in. */
export const SKILL_LIFECYCLE_STATES = ["candidate", "verified", "deprecated"] as const;
export type SkillLifecycleState = (typeof SKILL_LIFECYCLE_STATES)[number];

/** The approval type the promotion gate accepts. */
export const SKILL_PROMOTION_APPROVAL_TYPE = "skill_promotion";

/** The env var naming the pilot agents, comma-separated agent ids. */
export const SKILL_PILOT_AGENTS_ENV = "MYRMIDON_SKILL_PILOT_AGENTS";

export interface SkillLifecycleRecord {
  skillId: string;
  companyId: string;
  state: SkillLifecycleState;
  /** The revision delivered to agents. Null for a candidate that never had one. */
  verifiedVersionId: string | null;
  /** The revision the current one replaced; the rollback target. */
  previousVerifiedVersionId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reason: string | null;
  updatedAt: string;
}

export interface SkillLifecycleEvent {
  id: string;
  skillId: string;
  fromState: SkillLifecycleState | null;
  toState: SkillLifecycleState;
  versionId: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string | null;
  approvalId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface SkillLifecycleApprovalRef {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decidedByUserId: string | null;
  decidedAt: string | null;
}

/** Thrown for a lifecycle transition that the rules do not allow. */
export class SkillLifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillLifecycleError";
    this.code = code;
  }
}

export function isSkillLifecycleState(value: unknown): value is SkillLifecycleState {
  return typeof value === "string" && (SKILL_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * The promotion gate: an approval of the right type, already approved, and
 * about this very skill. Anything else — a missing approval, a pending one, a
 * mismatched type or skill — is a refusal, never a silent promotion.
 */
export function assertPromotionApproval(
  approval: SkillLifecycleApprovalRef | null,
  skillId: string,
): SkillLifecycleApprovalRef {
  if (!approval) {
    throw new SkillLifecycleError(
      "promotion_requires_approval",
      "Promotion requires an approved approval of type skill_promotion for this skill.",
    );
  }
  if (approval.type !== SKILL_PROMOTION_APPROVAL_TYPE) {
    throw new SkillLifecycleError(
      "promotion_approval_type_mismatch",
      `Approval ${approval.id} is of type "${approval.type}", not ${SKILL_PROMOTION_APPROVAL_TYPE}.`,
    );
  }
  const approvalSkillId = typeof approval.payload.skillId === "string" ? approval.payload.skillId : null;
  if (approvalSkillId !== skillId) {
    throw new SkillLifecycleError(
      "promotion_approval_skill_mismatch",
      `Approval ${approval.id} is not about this skill.`,
    );
  }
  if (approval.status !== "approved") {
    throw new SkillLifecycleError(
      "promotion_requires_approved_status",
      `Approval ${approval.id} is "${approval.status}", not approved.`,
    );
  }
  return approval;
}

/**
 * Promote: candidate (or deprecated) → verified, pointing at `versionId`.
 * The previous verified pointer is kept, so a later rollback has a target.
 */
export function nextPromotionFields(
  record: Pick<SkillLifecycleRecord, "verifiedVersionId"> | null,
  versionId: string,
  approval: SkillLifecycleApprovalRef,
  now: Date,
): Pick<SkillLifecycleRecord, "state" | "verifiedVersionId" | "previousVerifiedVersionId" | "approvedBy" | "approvedAt" | "reason"> {
  return {
    state: "verified",
    verifiedVersionId: versionId,
    previousVerifiedVersionId: record?.verifiedVersionId ?? null,
    approvedBy: approval.decidedByUserId ?? null,
    approvedAt: approval.decidedAt ?? now.toISOString(),
    reason: null,
  };
}

/**
 * The rollback target: the previous verified revision, from the record itself.
 * A record that never had a previous verified revision cannot be rolled back.
 */
export function rollbackTargetVersionId(record: SkillLifecycleRecord): string {
  if (!record.verifiedVersionId) {
    throw new SkillLifecycleError("rollback_no_verified_version", "The skill has no verified version to roll back from.");
  }
  if (!record.previousVerifiedVersionId) {
    throw new SkillLifecycleError(
      "rollback_no_previous_version",
      "The skill has no previous verified version to roll back to.",
    );
  }
  if (record.previousVerifiedVersionId === record.verifiedVersionId) {
    throw new SkillLifecycleError("rollback_no_previous_version", "The rollback target is the current version.");
  }
  return record.previousVerifiedVersionId;
}

/**
 * Fields after a rollback: the delivered pointer moves to the previous
 * revision, and the one that was live becomes the new previous, so a second
 * rollback toggles back. The state ends verified.
 */
export function nextRollbackFields(
  record: SkillLifecycleRecord,
): Pick<SkillLifecycleRecord, "state" | "verifiedVersionId" | "previousVerifiedVersionId" | "reason"> {
  const target = rollbackTargetVersionId(record);
  return {
    state: "verified",
    verifiedVersionId: target,
    previousVerifiedVersionId: record.verifiedVersionId,
    reason: null,
  };
}

/** What one agent gets for one skill, per the lifecycle. */
export interface SkillDeliveryDecision {
  /** True when the skill must not reach this agent at all. */
  blocked: boolean;
  /** Why it is blocked (null when delivered). */
  reason: string | null;
  /** The revision to deliver, when the lifecycle pins one. */
  pinnedVersionId: string | null;
}

/** The lifecycle facts the delivery decision needs, keyed by skill key. */
export interface SkillDeliveryState {
  state: SkillLifecycleState;
  verifiedVersionId: string | null;
}

/**
 * Decide what one agent gets for one skill.
 *
 * A skill with no lifecycle row is legacy/unmanaged: it keeps the pre-feature
 * behaviour and reaches everyone. Verified reaches everyone. A candidate
 * reaches the pilot agent set only. Deprecated reaches nobody.
 */
export function decideSkillDelivery(input: {
  skillKey: string;
  agentId: string;
  lifecycle: SkillDeliveryState | null | undefined;
  pilotAgentIds: ReadonlySet<string>;
}): SkillDeliveryDecision {
  const { skillKey, agentId, lifecycle, pilotAgentIds } = input;
  if (!lifecycle) return { blocked: false, reason: null, pinnedVersionId: null };
  if (lifecycle.state === "verified") {
    return { blocked: false, reason: null, pinnedVersionId: lifecycle.verifiedVersionId };
  }
  if (lifecycle.state === "deprecated") {
    return { blocked: true, reason: `skill ${skillKey} is deprecated`, pinnedVersionId: null };
  }
  // candidate
  if (pilotAgentIds.has(agentId)) {
    return { blocked: false, reason: null, pinnedVersionId: lifecycle.verifiedVersionId };
  }
  return { blocked: true, reason: `skill ${skillKey} is a candidate and this agent is not in the pilot set`, pinnedVersionId: null };
}

/**
 * The pilot agent set from the environment. A blank or unset value is an empty
 * set: a candidate then reaches nobody, which is the safe reading of "no pilot
 * configured".
 */
export function readSkillPilotAgents(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[SKILL_PILOT_AGENTS_ENV];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}