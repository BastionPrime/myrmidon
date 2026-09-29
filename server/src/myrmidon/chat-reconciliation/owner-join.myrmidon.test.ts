// myrmidon(D1): behavioral test for coalescedOwnerId's generated SQL against
// a real Postgres engine. See docs/myrmidon/DIVERGENCE.md.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { coalescedOwnerId } from "./owner-join.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("coalescedOwnerId", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-join-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWake(payload: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId,
      agentId,
      source: "automation",
      status: "queued",
      payload,
    });
    return id;
  }

  async function ownerIdFor(sourceId: string): Promise<string> {
    const [row] = await db
      .select({
        ownerId: coalescedOwnerId(agentWakeupRequests.payload, agentWakeupRequests.id),
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, sourceId));
    return row?.ownerId as unknown as string;
  }

  it("resolves to the coalesced owner when the payload names one", async () => {
    const ownerId = await seedWake();
    const childId = await seedWake({ coalescedIntoWakeupRequestId: ownerId });

    expect(await ownerIdFor(childId)).toBe(ownerId);
  });

  it("falls back to the row's own id when the payload names no owner", async () => {
    const soloId = await seedWake();

    expect(await ownerIdFor(soloId)).toBe(soloId);
  });

  it("falls back to the row's own id instead of throwing on a malformed value", async () => {
    const malformedId = await seedWake({ coalescedIntoWakeupRequestId: "not-a-uuid" });

    expect(await ownerIdFor(malformedId)).toBe(malformedId);
  });
});
