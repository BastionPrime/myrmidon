// server/src/__tests__/agents-service-caste-directory.myrmidon.test.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES B): the agent create/update role validation
// against the company caste directory.
//
// The shared validator checks the role *format* (a caste key: latin letters,
// digits, hyphens, 1–60). Whether the key is a caste *of this company* is a
// server-side check in the agent service: create and update refuse a role
// that is not in the company's directory with 400, and accept one that is.
// Until part A (the directory store) lands, the directory read is injected
// as a port — this test drives it with an in-memory fake (the "mock the
// directory read" the ticket prescribes). Without the port the check is a
// no-op, which keeps the pre-directory behavior exactly.
//
// Neutral data only: agent-a, company-a.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** The in-memory caste directory: part A's read contract, faked. */
function fakeCasteDirectory(keys: readonly string[]) {
  const reads: string[] = [];
  return {
    listCasteKeys: async (companyId: string) => {
      reads.push(companyId);
      return keys;
    },
    reads: () => reads,
  };
}

describeEmbeddedPostgres("agent service role validation against the caste directory", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-caste-directory-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db
      .insert(companies)
      .values({
        id: companyId,
        name: "Caste Co",
        issuePrefix: `CC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      });
    return companyId;
  }

  const baseAgent = {
    name: "agent-a",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  };

  it("create with a role that is a caste of the company succeeds (200 path)", async () => {
    const companyId = await seedCompany();
    const directory = fakeCasteDirectory(["engineer", "reviewer", "lead"]);
    const svc = agentService(db, { castes: directory });
    const created = await svc.create(companyId, {
      ...baseAgent,
      role: "reviewer",
    });
    expect(created?.role).toBe("reviewer");
    expect(directory.reads()).toEqual([companyId]);
  });

  it("create with a role that is NOT a caste of the company is a 400 with a named key", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db, { castes: fakeCasteDirectory(["engineer", "reviewer"]) });
    await expect(
      svc.create(companyId, {
        ...baseAgent,
        role: "nonexistent-caste",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("nonexistent-caste"),
      details: { code: "role_not_company_caste", role: "nonexistent-caste" },
    });
    // Nothing was written.
    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(0);
  });

  it("update to a caste of the company succeeds; update to an unknown caste is a 400", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db, { castes: fakeCasteDirectory(["engineer", "reviewer"]) });
    const created = await svc.create(companyId, { ...baseAgent, role: "engineer" });
    expect(created).not.toBeNull();

    const updated = await svc.update(created!.id, { role: "reviewer" });
    expect(updated?.role).toBe("reviewer");

    await expect(svc.update(created!.id, { role: "ghost-caste" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("ghost-caste"),
    });
    // The failed update left the previous role in place.
    const after = await svc.getById(created!.id);
    expect(after?.role).toBe("reviewer");
  });

  it("without the directory port the check is skipped (pre-part-A behavior)", async () => {
    const companyId = await seedCompany();
    const svc = agentService(db);
    const created = await svc.create(companyId, {
      ...baseAgent,
      // A custom role key the fake directory would refuse — the legacy build
      // accepts it, exactly as before the caste directory existed.
      role: "legacy-caste",
    });
    expect(created?.role).toBe("legacy-caste");
  });
});

describe("agent role validator format (no database)", () => {
  it("accepts caste-key roles and refuses malformed ones", async () => {
    const { createAgentSchema } = await import("@paperclipai/shared");
    expect(createAgentSchema.parse({ name: "agent-a", role: "reviewer", adapterType: "process" }).role).toBe(
      "reviewer",
    );
    expect(
      createAgentSchema.parse({ name: "agent-a", role: "focused-qa-2", adapterType: "process" }).role,
    ).toBe("focused-qa-2");
    expect(createAgentSchema.parse({ name: "agent-a", adapterType: "process" }).role).toBe("general");
    for (const bad of ["", "  ", "has space", "кириллица", "under_score", "a".repeat(61)]) {
      expect(() =>
        createAgentSchema.parse({ name: "agent-a", role: bad, adapterType: "process" }),
      ).toThrow();
    }
  });
});
