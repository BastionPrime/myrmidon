import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// myrmidon(L3c): resume must not report "idle" while the agent still owns a
// running run left over from a drained pause.
describeEmbeddedPostgres("agent service resume with a live run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-resume-live-run-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(runStatus: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resume", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Resumer",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date(),
      adapterType: "hermes_gateway",
      adapterConfig: {},
    });
    if (runStatus) {
      await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: runStatus });
    }
    return agentId;
  }

  it("resumes to running while a run is still running", async () => {
    const agentId = await seed("running");
    const resumed = await agentService(db).resume(agentId);
    expect(resumed).toMatchObject({ status: "running", pauseReason: null, pausedAt: null });
  });

  it("resumes to idle when no run is running", async () => {
    const agentId = await seed("cancelled");
    const resumed = await agentService(db).resume(agentId);
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });
  });
});
