// myrmidon(1.6-SKILL-LIFE): the lifecycle routes over the real service with a
// fake store — permissions, the approval gate and the rollback response.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { skillLifecycleRoutes, type SkillLifecycleRoutesDeps } from "./routes.js";
import { createSkillLifecycleService } from "./service.js";
import { SKILL_PROMOTION_APPROVAL_TYPE } from "./domain.js";
import type { SkillLifecycleSkillRef, SkillLifecycleStore, SkillLifecycleVersionRef } from "./store.js";
import type { SkillLifecycleApprovalRef, SkillLifecycleRecord } from "./domain.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "10000000-0000-4000-8000-000000000002";
const SKILL = "10000000-0000-4000-8000-0000000000a1";
const V1 = "10000000-0000-4000-8000-0000000000c1";
const V2 = "10000000-0000-4000-8000-0000000000c2";
const APPROVAL = "10000000-0000-4000-8000-0000000000d1";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY],
};
const agent = {
  type: "agent",
  source: "agent_key",
  agentId: "10000000-0000-4000-8000-0000000000b1",
  companyId: COMPANY,
  keyId: "key-a",
};

const SKILL_REF: SkillLifecycleSkillRef = {
  id: SKILL,
  key: "example-skill",
  name: "Example skill",
  slug: "example-skill",
  currentVersionId: V2,
};

function store(seed: {
  records?: SkillLifecycleRecord[];
  approvals?: SkillLifecycleApprovalRef[];
}): SkillLifecycleStore {
  const records = new Map((seed.records ?? []).map((record) => [record.skillId, { ...record }] as const));
  const approvals = new Map((seed.approvals ?? []).map((approval) => [approval.id, approval] as const));
  const versions: Record<string, SkillLifecycleVersionRef> = {
    [V1]: { id: V1, revisionNumber: 1, fileInventory: [{ path: "SKILL.md", content: "content A" }] },
    [V2]: { id: V2, revisionNumber: 2, fileInventory: [{ path: "SKILL.md", content: "content B" }] },
  };
  let sequence = 0;
  return {
    async getSkill(_companyId, skillId) {
      return skillId === SKILL ? { ...SKILL_REF } : null;
    },
    async listSkills() {
      return [{ ...SKILL_REF }];
    },
    async getRecord(companyId, skillId) {
      const record = records.get(skillId);
      return companyId === COMPANY && record ? { ...record } : null;
    },
    async listRecords(companyId) {
      return companyId === COMPANY ? [...records.values()] : [];
    },
    async saveRecord(record) {
      records.set(record.skillId, { ...record });
      return { ...record };
    },
    async appendEvent(event) {
      sequence += 1;
      return { ...event, id: `event-${sequence}`, createdAt: new Date().toISOString() };
    },
    async listEvents() {
      return [];
    },
    async getVersion(_companyId, _skillId, versionId) {
      return versions[versionId] ?? null;
    },
    async getApproval(approvalId) {
      return approvals.get(approvalId) ?? null;
    },
    async setSkillCurrentVersion() {},
  };
}

function verifiedRecord(): SkillLifecycleRecord {
  return {
    skillId: SKILL,
    companyId: COMPANY,
    state: "verified",
    verifiedVersionId: V2,
    previousVerifiedVersionId: V1,
    approvedBy: "user-b",
    approvedAt: "2026-10-02T09:00:00.000Z",
    reason: null,
    updatedAt: "2026-10-02T09:00:00.000Z",
  };
}

function harness(options: { approvals?: SkillLifecycleApprovalRef[]; records?: SkillLifecycleRecord[] } = {}) {
  const createPromotionApproval = vi.fn(async () => ({ approvalId: APPROVAL }));
  const deps: SkillLifecycleRoutesDeps = {
    service: createSkillLifecycleService({ store: store(options), env: {} }),
    createPromotionApproval,
  };
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", skillLifecycleRoutes(deps));
    app.use(errorHandler);
    return app;
  };
  return { withActor, createPromotionApproval };
}

const base = `/api/myrmidon/companies/${COMPANY}/skill-lifecycle`;

describe("myrmidon(1.6-SKILL-LIFE): routes", () => {
  it("lists the lifecycle view for a company member", async () => {
    const { withActor } = harness({ records: [verifiedRecord()] });
    const res = await request(withActor(member)).get(base).expect(200);
    expect(res.body.skills).toHaveLength(1);
    expect(res.body.skills[0]).toMatchObject({ key: "example-skill", state: "verified", approvedBy: "user-b" });
  });

  it("refuses an agent from another company", async () => {
    const { withActor } = harness();
    await request(withActor({ ...agent, companyId: OTHER_COMPANY })).get(base).expect(403);
  });

  it("refuses a mutation from an agent actor", async () => {
    const { withActor } = harness({ records: [verifiedRecord()] });
    await request(withActor(agent)).post(`${base}/${SKILL}/rollback`).expect(403);
  });

  it("refuses a promotion without an approval id", async () => {
    const { withActor } = harness({ records: [verifiedRecord()] });
    await request(withActor(member)).post(`${base}/${SKILL}/promote`).send({}).expect(400);
  });

  it("refuses a promotion whose approval is not approved", async () => {
    const { withActor } = harness({
      records: [verifiedRecord()],
      approvals: [
        {
          id: APPROVAL,
          type: SKILL_PROMOTION_APPROVAL_TYPE,
          status: "pending",
          payload: { skillId: SKILL },
          decidedByUserId: null,
          decidedAt: null,
        },
      ],
    });
    const res = await request(withActor(member)).post(`${base}/${SKILL}/promote`).send({ approvalId: APPROVAL }).expect(422);
    expect(res.body.details?.code).toBe("promotion_requires_approved_status");
  });

  it("rolls back to the previous verified revision", async () => {
    const { withActor } = harness({ records: [verifiedRecord()] });
    const res = await request(withActor(member)).post(`${base}/${SKILL}/rollback`).expect(200);
    expect(res.body).toMatchObject({ state: "verified", verifiedVersionId: V1, verifiedRevisionNumber: 1 });
  });

  it("opens a promotion approval card", async () => {
    const { withActor, createPromotionApproval } = harness({ records: [verifiedRecord()] });
    const res = await request(withActor(member)).post(`${base}/${SKILL}/promote-request`).send({ note: "ship it" }).expect(201);
    expect(res.body.approvalId).toBe(APPROVAL);
    expect(createPromotionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY, skillId: SKILL, skillKey: "example-skill", note: "ship it" }),
    );
  });
});