// server/src/myrmidon/castes/castes.db.myrmidon.test.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): the service + store against a real
// database — the seed, CRUD rules, the reassign-on-delete transaction and the
// company boundary.
//
// The role-queue consequence of reassign is asserted through roleQueueRows
// (the 1.6-SWARM queue read): after DELETE with reassignTo, the agent reads
// with the new role and its todo task is in the new caste's queue, not the
// old one's.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentCastes,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { roleQueueRows } from "../swarm-claim/queue.js";
import { createCasteService, type CasteActivityEntry } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(1.6.1 CUSTOM-CASTES) service over the database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-castes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(agentCastes);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(): Promise<string> {
    const row = await db
      .insert(companies)
      .values({
        name: `company ${randomUUID()}`,
        issuePrefix: `CC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  function makeService() {
    const activity: Array<CasteActivityEntry> = [];
    const service = createCasteService({
      db,
      now: () => new Date("2026-01-02T00:00:00Z"),
    });
    return { service, activity };
  }

  async function makeAgent(companyId: string, role: string): Promise<string> {
    const row = await db
      .insert(agents)
      .values({
        companyId,
        name: `agent-${role}-${randomUUID().slice(0, 6)}`,
        role,
      })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  async function makeTodoIssue(
    companyId: string,
    assigneeAgentId: string,
  ): Promise<string> {
    const row = await db
      .insert(issues)
      .values({
        companyId,
        title: `task ${randomUUID().slice(0, 6)}`,
        status: "todo",
        assigneeAgentId,
      })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  it("seeds exactly 12 built-in castes on the first read and repeats identically", async () => {
    companyId = await makeCompany();
    const { service } = makeService();
    const first = await service.listCastes(companyId);
    expect(first).toHaveLength(12);
    expect(first.every((c) => c.builtIn)).toBe(true);
    expect(first.map((c) => c.key).sort()).toEqual(
      [
        "ceo", "cto", "cmo", "cfo", "security", "engineer",
        "designer", "pm", "qa", "devops", "researcher", "general",
      ].sort(),
    );
    const engineer = first.find((c) => c.key === "engineer")!;
    expect(engineer.nameEn).toBe("Engineer");
    expect(engineer.swarmEligible).toBe(true);
    expect(engineer.maxActiveTasks).toBeNull();

    const second = await service.listCastes(companyId);
    expect(second.map((c) => c.key).sort()).toEqual(first.map((c) => c.key).sort());
    expect(second).toHaveLength(12);
  });

  it("creates a caste; a duplicate key is a 409; PATCH mutates the mutable fields; PATCH key is a 400", async () => {
    companyId = await makeCompany();
    const { service, activity } = makeService();
    await service.listCastes(companyId); // seed

    const created = await service.createCaste({
      companyId,
      body: { key: "ops", nameEn: "Ops", color: "amber", swarmEligible: false, maxActiveTasks: 5 },
      activity: (e) => void activity.push(e),
    });
    expect(created.key).toBe("ops");
    expect(created.builtIn).toBe(false);
    expect(created.swarmEligible).toBe(false);
    expect(created.maxActiveTasks).toBe(5);

    await expect(
      service.createCaste({ companyId, body: { key: "ops", nameEn: "Ops again" } }),
    ).rejects.toMatchObject({ status: 409 });

    const patched = await service.updateCaste({
      companyId,
      key: "ops",
      body: { nameEn: "Operations", nameRu: "Операции", color: "violet", swarmEligible: true, maxActiveTasks: null },
    });
    expect(patched.nameEn).toBe("Operations");
    expect(patched.nameRu).toBe("Операции");
    expect(patched.color).toBe("violet");
    expect(patched.swarmEligible).toBe(true);
    expect(patched.maxActiveTasks).toBeNull();

    await expect(
      service.updateCaste({ companyId, key: "ops", body: { nameEn: "X", key: "new-key" } as never }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.updateCaste({ companyId, key: "ops", body: { nameEn: "X", builtIn: true } as never }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("deletes a caste without agents (204 path) and keeps one with agents without reassignTo a 409", async () => {
    companyId = await makeCompany();
    const { service } = makeService();
    await service.listCastes(companyId); // seed
    await service.createCaste({ companyId, body: { key: "ops", nameEn: "Ops" } });

    await service.removeCaste({ companyId, key: "ops" });
    const after = await service.listCastes(companyId);
    expect(after.find((c) => c.key === "ops")).toBeUndefined();

    // built-in with an agent on it: no reassignTo -> 409
    await makeAgent(companyId, "qa");
    await expect(service.removeCaste({ companyId, key: "qa" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("DELETE with reassignTo moves the agents and their todo task into the target caste's queue, transactionally", async () => {
    companyId = await makeCompany();
    const { service } = makeService();
    await service.listCastes(companyId); // seed
    await service.createCaste({ companyId, body: { key: "ops", nameEn: "Ops" } });

    const agentId = await makeAgent(companyId, "qa");
    const issueId = await makeTodoIssue(companyId, agentId);

    // before: the task is in the qa queue, not in ops
    const qaBefore = await roleQueueRows(db, companyId, "qa").then((rows) => rows.map((r) => r.issueId));
    const opsBefore = await roleQueueRows(db, companyId, "ops").then((rows) => rows.map((r) => r.issueId));
    expect(qaBefore).toContain(issueId);
    expect(opsBefore).not.toContain(issueId);

    // reassignTo must exist and differ from the key
    await expect(
      service.removeCaste({ companyId, key: "qa", reassignTo: "nope" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.removeCaste({ companyId, key: "qa", reassignTo: "qa" }),
    ).rejects.toMatchObject({ status: 400 });

    await service.removeCaste({ companyId, key: "qa", reassignTo: "ops" });

    const agentRows = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRows[0]!.role).toBe("ops");

    const qaAfter = await roleQueueRows(db, companyId, "qa").then((rows) => rows.map((r) => r.issueId));
    const opsAfter = await roleQueueRows(db, companyId, "ops").then((rows) => rows.map((r) => r.issueId));
    expect(qaAfter).not.toContain(issueId);
    expect(opsAfter).toContain(issueId);

    const castes = await service.listCastes(companyId);
    expect(castes.find((c) => c.key === "qa")).toBeUndefined();
    expect(castes.find((c) => c.key === "ops")).toBeDefined();
  });

  it("enforces the company boundary: company A's castes are invisible to company B", async () => {
    const companyA = await makeCompany();
    const companyB = await makeCompany();
    const { service } = makeService();
    await service.listCastes(companyA);
    await service.listCastes(companyB);

    await service.createCaste({ companyId: companyA, body: { key: "ops", nameEn: "Ops" } });

    const listB = await service.listCastes(companyB);
    expect(listB.find((c) => c.key === "ops")).toBeUndefined();
    expect(listB).toHaveLength(12);

    await expect(
      service.updateCaste({ companyId: companyB, key: "ops", body: { nameEn: "Hijack" } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.removeCaste({ companyId: companyB, key: "ops" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
