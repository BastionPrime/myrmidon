// myrmidon(1.6-SKILL-LIFE): the lifecycle state machine, the approval gate,
// the rollback and the delivery projection, over a fake store.
//
// The acceptance points are here: a rollback restores the previous verified
// content, a candidate does not reach an agent outside the pilot set, and a
// promotion without an approved approval is refused.

import { describe, expect, it } from "vitest";
import {
  SKILL_PILOT_AGENTS_ENV,
  SKILL_PROMOTION_APPROVAL_TYPE,
  decideSkillDelivery,
  nextPromotionFields,
  readSkillPilotAgents,
  rollbackTargetVersionId,
  SkillLifecycleError,
  assertPromotionApproval,
} from "./domain.js";
import { createSkillLifecycleService, type SkillLifecycleActor } from "./service.js";
import type {
  SkillLifecycleSkillRef,
  SkillLifecycleStore,
  SkillLifecycleVersionRef,
} from "./store.js";
import type { SkillLifecycleApprovalRef, SkillLifecycleEvent, SkillLifecycleRecord } from "./domain.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const SKILL = "10000000-0000-4000-8000-0000000000a1";
const AGENT_PILOT = "10000000-0000-4000-8000-0000000000b1";
const AGENT_OTHER = "10000000-0000-4000-8000-0000000000b2";
const V1 = "10000000-0000-4000-8000-0000000000c1";
const V2 = "10000000-0000-4000-8000-0000000000c2";
const APPROVAL = "10000000-0000-4000-8000-0000000000d1";

const actor: SkillLifecycleActor = { actorType: "user", actorId: "user-a" };

/** An in-memory stand-in for the drizzle store; no Postgres in the unit run. */
function fakeStore(seed: {
  skills: SkillLifecycleSkillRef[];
  versions: Record<string, SkillLifecycleVersionRef>;
  records?: SkillLifecycleRecord[];
  approvals?: SkillLifecycleApprovalRef[];
}) {
  const skills = new Map<string, SkillLifecycleSkillRef>(
    seed.skills.map((skill) => [skill.id, { ...skill }]),
  );
  const records = new Map((seed.records ?? []).map((record) => [record.skillId, { ...record }] as const));
  const approvals = new Map((seed.approvals ?? []).map((approval) => [approval.id, approval] as const));
  const events: SkillLifecycleEvent[] = [];
  const currentVersionCalls: Array<{ skillId: string; versionId: string | null }> = [];
  const activities: Array<Record<string, unknown>> = [];
  let sequence = 0;

  const store: SkillLifecycleStore = {
    async getSkill(companyId, skillId) {
      const skill = skills.get(skillId);
      if (!skill) return null;
      return companyId === COMPANY ? { ...skill } : null;
    },
    async listSkills(companyId) {
      return companyId === COMPANY ? [...skills.values()].map((skill) => ({ ...skill })) : [];
    },
    async getRecord(companyId, skillId) {
      const record = records.get(skillId);
      return companyId === COMPANY && record ? { ...record } : null;
    },
    async listRecords(companyId) {
      return companyId === COMPANY ? [...records.values()].map((record) => ({ ...record })) : [];
    },
    async saveRecord(record) {
      records.set(record.skillId, { ...record });
      return { ...record };
    },
    async appendEvent(event) {
      sequence += 1;
      const stored: SkillLifecycleEvent = {
        ...event,
        id: `event-${sequence}`,
        createdAt: event.createdAt ?? new Date(2026, 0, sequence).toISOString(),
      };
      events.push(stored);
      return stored;
    },
    async listEvents(companyId, skillId) {
      if (companyId !== COMPANY) return [];
      return events.filter((event) => event.skillId === skillId).reverse();
    },
    async getVersion(companyId, skillId, versionId) {
      if (companyId !== COMPANY) return null;
      const version = seed.versions[versionId];
      return version && version.id === versionId ? { ...version } : null;
    },
    async getApproval(approvalId) {
      return approvals.get(approvalId) ?? null;
    },
    async setSkillCurrentVersion(companyId, skillId, versionId) {
      if (companyId !== COMPANY) return;
      const skill = skills.get(skillId);
      if (skill) skill.currentVersionId = versionId;
      currentVersionCalls.push({ skillId, versionId });
    },
  };

  return { store, records, events, currentVersionCalls, activities, skills };
}

function serviceWith(store: SkillLifecycleStore, env: NodeJS.ProcessEnv = {}) {
  return createSkillLifecycleService({
    store,
    env,
    now: () => new Date("2026-10-02T10:00:00.000Z"),
  });
}

function version(id: string, revisionNumber: number, content: string): SkillLifecycleVersionRef {
  return { id, revisionNumber, fileInventory: [{ path: "SKILL.md", kind: "markdown", content }] };
}

const SKILL_REF: SkillLifecycleSkillRef = {
  id: SKILL,
  key: "example-skill",
  name: "Example skill",
  slug: "example-skill",
  currentVersionId: V1,
};

function approved(overrides: Partial<SkillLifecycleApprovalRef> = {}): SkillLifecycleApprovalRef {
  return {
    id: APPROVAL,
    type: SKILL_PROMOTION_APPROVAL_TYPE,
    status: "approved",
    payload: { skillId: SKILL },
    decidedByUserId: "user-b",
    decidedAt: "2026-10-02T09:00:00.000Z",
    ...overrides,
  };
}

describe("myrmidon(1.6-SKILL-LIFE): promotion needs an approved approval", () => {
  it("refuses a promotion with no approval at all", () => {
    expect(() => assertPromotionApproval(null, SKILL)).toThrowError(SkillLifecycleError);
    try {
      assertPromotionApproval(null, SKILL);
    } catch (error) {
      expect((error as SkillLifecycleError).code).toBe("promotion_requires_approval");
    }
  });

  it("refuses a pending approval, a wrong type and a wrong skill", () => {
    expect(() => assertPromotionApproval(approved({ status: "pending" }), SKILL)).toThrowError(
      /not approved/,
    );
    expect(() => assertPromotionApproval(approved({ type: "hire_agent" }), SKILL)).toThrowError(
      /type "hire_agent"/,
    );
    expect(() => assertPromotionApproval(approved({ payload: { skillId: "other" } }), SKILL)).toThrowError(
      /not about this skill/,
    );
  });

  it("promotes a candidate to verified once an approved approval is supplied", async () => {
    const harness = fakeStore({
      skills: [{ ...SKILL_REF }],
      versions: { [V1]: version(V1, 1, "first") },
      records: [
        {
          skillId: SKILL,
          companyId: COMPANY,
          state: "candidate",
          verifiedVersionId: V1,
          previousVerifiedVersionId: null,
          approvedBy: null,
          approvedAt: null,
          reason: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      approvals: [approved()],
    });
    const service = serviceWith(harness.store);
    const view = await service.promote(COMPANY, SKILL, { approvalId: APPROVAL, actor });
    expect(view.state).toBe("verified");
    expect(view.verifiedVersionId).toBe(V1);
    expect(view.approvedBy).toBe("user-b");
    expect(harness.events[0]?.toState).toBe("verified");
    expect(harness.events[0]?.approvalId).toBe(APPROVAL);
  });

  it("does not promote when the store holds no approved approval", async () => {
    const harness = fakeStore({
      skills: [{ ...SKILL_REF }],
      versions: { [V1]: version(V1, 1, "first") },
      approvals: [approved({ status: "pending" })],
    });
    const service = serviceWith(harness.store);
    await expect(service.promote(COMPANY, SKILL, { approvalId: APPROVAL, actor })).rejects.toMatchObject({
      code: "promotion_requires_approved_status",
    });
    expect(harness.records.get(SKILL)).toBeUndefined();
  });
});

describe("myrmidon(1.6-SKILL-LIFE): delivery by state", () => {
  it("keeps a skill with no lifecycle row reaching everyone (legacy)", async () => {
    const harness = fakeStore({ skills: [{ ...SKILL_REF }], versions: { [V1]: version(V1, 1, "first") } });
    const service = serviceWith(harness.store);
    const delivery = await service.resolveDelivery(COMPANY, AGENT_OTHER);
    expect(delivery.blockedKeys.size).toBe(0);
    expect(delivery.pinnedVersions.size).toBe(0);
  });

  it("withholds a candidate from an agent outside the pilot set and delivers it to the pilot", async () => {
    const harness = fakeStore({
      skills: [{ ...SKILL_REF }],
      versions: { [V1]: version(V1, 1, "candidate content") },
      records: [
        {
          skillId: SKILL,
          companyId: COMPANY,
          state: "candidate",
          verifiedVersionId: V1,
          previousVerifiedVersionId: null,
          approvedBy: null,
          approvedAt: null,
          reason: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const service = serviceWith(harness.store, { [SKILL_PILOT_AGENTS_ENV]: AGENT_PILOT });

    const outside = await service.resolveDelivery(COMPANY, AGENT_OTHER);
    expect(outside.blockedKeys.has("example-skill")).toBe(true);
    expect(outside.reasons.get("example-skill")).toContain("candidate");

    const pilot = await service.resolveDelivery(COMPANY, AGENT_PILOT);
    expect(pilot.blockedKeys.size).toBe(0);
    expect(pilot.pinnedVersions.get("example-skill")).toBe(V1);
  });

  it("withholds a deprecated skill from everyone", async () => {
    const harness = fakeStore({
      skills: [{ ...SKILL_REF }],
      versions: { [V1]: version(V1, 1, "first") },
      records: [
        {
          skillId: SKILL,
          companyId: COMPANY,
          state: "deprecated",
          verifiedVersionId: V1,
          previousVerifiedVersionId: null,
          approvedBy: "user-b",
          approvedAt: "2026-10-01T00:00:00.000Z",
          reason: "superseded",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const service = serviceWith(harness.store, { [SKILL_PILOT_AGENTS_ENV]: AGENT_PILOT });
    for (const agentId of [AGENT_PILOT, AGENT_OTHER]) {
      const delivery = await service.resolveDelivery(COMPANY, agentId);
      expect(delivery.blockedKeys.has("example-skill")).toBe(true);
    }
  });

  it("treats a blank pilot setting as an empty set", () => {
    expect(readSkillPilotAgents({}).size).toBe(0);
    expect(readSkillPilotAgents({ [SKILL_PILOT_AGENTS_ENV]: "  " }).size).toBe(0);
    expect([...readSkillPilotAgents({ [SKILL_PILOT_AGENTS_ENV]: "a, b ,c" })]).toEqual(["a", "b", "c"]);
  });

  it("decides directly for a verified skill and pins its verified revision", () => {
    const decision = decideSkillDelivery({
      skillKey: "k",
      agentId: AGENT_OTHER,
      lifecycle: { state: "verified", verifiedVersionId: V2 },
      pilotAgentIds: new Set(),
    });
    expect(decision).toEqual({ blocked: false, reason: null, pinnedVersionId: V2 });
  });
});

describe("myrmidon(1.6-SKILL-LIFE): rollback restores the previous verified content", () => {
  it("moves the delivered revision back and every agent reads the previous content", async () => {
    const harness = fakeStore({
      skills: [{ ...SKILL_REF, currentVersionId: V2 }],
      versions: {
        [V1]: version(V1, 1, "content A"),
        [V2]: version(V2, 2, "content B"),
      },
      records: [
        {
          skillId: SKILL,
          companyId: COMPANY,
          state: "verified",
          verifiedVersionId: V2,
          previousVerifiedVersionId: V1,
          approvedBy: "user-b",
          approvedAt: "2026-10-02T09:00:00.000Z",
          reason: null,
          updatedAt: "2026-10-02T09:00:00.000Z",
        },
      ],
    });
    const service = serviceWith(harness.store);

    // Before the rollback the agent gets revision 2 (content B).
    const before = await service.verifiedContent(COMPANY, SKILL);
    expect(before?.revisionNumber).toBe(2);
    expect(before?.files[0]?.content).toBe("content B");
    expect((await service.resolveDelivery(COMPANY, AGENT_OTHER)).pinnedVersions.get("example-skill")).toBe(V2);

    const view = await service.rollback(COMPANY, SKILL, actor);
    expect(view.state).toBe("verified");
    expect(view.verifiedVersionId).toBe(V1);
    expect(view.previousVerifiedVersionId).toBe(V2);
    expect(view.verifiedRevisionNumber).toBe(1);
    // The delivery pointer moved too: the compiler reads current_version_id.
    expect(harness.currentVersionCalls).toEqual([{ skillId: SKILL, versionId: V1 }]);

    // On the next run of every agent that uses the skill, the content is the
    // previous verified revision's.
    const after = await service.verifiedContent(COMPANY, SKILL);
    expect(after?.revisionNumber).toBe(1);
    expect(after?.files[0]?.content).toBe("content A");
    for (const agentId of [AGENT_PILOT, AGENT_OTHER]) {
      const delivery = await service.resolveDelivery(COMPANY, agentId);
      expect(delivery.blockedKeys.size).toBe(0);
      expect(delivery.pinnedVersions.get("example-skill")).toBe(V1);
    }
    expect(harness.events.at(-1)?.toState).toBe("verified");
    expect(harness.events.at(-1)?.versionId).toBe(V1);
  });

  it("refuses a rollback when there is no previous verified revision", () => {
    const record: SkillLifecycleRecord = {
      skillId: SKILL,
      companyId: COMPANY,
      state: "verified",
      verifiedVersionId: V1,
      previousVerifiedVersionId: null,
      approvedBy: null,
      approvedAt: null,
      reason: null,
      updatedAt: "2026-10-02T09:00:00.000Z",
    };
    expect(() => rollbackTargetVersionId(record)).toThrowError(/no previous verified version/);
  });

  it("refuses a rollback on a skill without a lifecycle record", async () => {
    const harness = fakeStore({ skills: [{ ...SKILL_REF }], versions: { [V1]: version(V1, 1, "first") } });
    const service = serviceWith(harness.store);
    await expect(service.rollback(COMPANY, SKILL, actor)).rejects.toMatchObject({
      code: "rollback_no_verified_version",
    });
  });

  it("records the previous pointer on promotion so a later rollback has a target", () => {
    const fields = nextPromotionFields({ verifiedVersionId: V1 }, V2, approved(), new Date("2026-10-02T10:00:00.000Z"));
    expect(fields.verifiedVersionId).toBe(V2);
    expect(fields.previousVerifiedVersionId).toBe(V1);
    expect(fields.state).toBe("verified");
  });
});