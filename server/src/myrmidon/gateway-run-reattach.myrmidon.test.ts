import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY,
  sweepGatewayRunReattach,
  type GatewayRunReattachHeartbeatPort,
} from "./gateway-run-reattach.js";

// myrmidon(HERMES-RUN-REATTACH): after the board restarts without maintenance
// mode, a running hermes_gateway heartbeat run whose gateway run id was
// persisted on the row must be re-dispatched for reattach, not failed as
// "Process lost". Runs of other adapters, terminal runs, and runs without a
// gateway run id are left alone.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `company-a ${randomUUID()}`,
      issuePrefix: `MS${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: Db,
  companyId: string,
  adapterType: string,
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `agent-${randomUUID().slice(0, 8)}`,
      adapterType,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createRun(
  db: Db,
  agent: { id: string; companyId: string },
  values: {
    status?: string;
    externalRunId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
  } = {},
) {
  return db
    .insert(heartbeatRuns)
    .values({
      agentId: agent.id,
      companyId: agent.companyId,
      mode: "heartbeat",
      runtimeMode: "legacy",
      status: values.status ?? "running",
      contextSnapshot: values.contextSnapshot ?? {},
      externalRunId: values.externalRunId ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("myrmidon(HERMES-RUN-REATTACH) gateway run reattach sweep", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-gateway-run-reattach-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeHeartbeatPort(calls: Array<{ runId: string; gatewayRunId: string }>): GatewayRunReattachHeartbeatPort {
    return {
      executeRunForGatewayReattach: async (runId, gatewayRunId) => {
        calls.push({ runId, gatewayRunId });
      },
    };
  }

  it("re-dispatches running hermes_gateway runs with a persisted gateway run id", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const run = await createRun(db, agent, { externalRunId: "gw-run-1" });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.reattached).toBe(1);
    expect(result.runIds).toEqual([run.id]);
    expect(calls).toEqual([{ runId: run.id, gatewayRunId: "gw-run-1" }]);

    // The row now carries the reattach marker (idempotent compare-and-set) and
    // a controller lease this boot owns, so the orphan reaper skips it while
    // the reattach execution spins up.
    const [after] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(after?.contextSnapshot).toMatchObject({
      [REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY]: "gw-run-1",
    });
    expect(after?.executionStage).toBe("reattaching");
    expect(after?.controllerBootId).not.toBeNull();
    expect(after?.controllerLeaseExpiresAt).not.toBeNull();
  });

  it("ignores terminal runs, other adapters, and runs without a gateway run id", async () => {
    const company = await createCompany(db);
    const gatewayAgent = await createAgent(db, company.id, "hermes_gateway");
    const otherAgent = await createAgent(db, company.id, "hermes_local");

    await createRun(db, gatewayAgent, { externalRunId: "gw-run-1", status: "completed" });
    await createRun(db, gatewayAgent, { status: "running", externalRunId: null });
    await createRun(db, otherAgent, { status: "running", externalRunId: "gw-run-2" });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.scanned).toBe(0);
    expect(result.reattached).toBe(0);
    expect(calls).toEqual([]);
  });

  it("does not re-dispatch a run a previous pass already marked", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    await createRun(db, agent, {
      externalRunId: "gw-run-1",
      contextSnapshot: { [REATTACH_GATEWAY_RUN_ID_CONTEXT_KEY]: "gw-run-1" },
    });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const result = await sweepGatewayRunReattach(db, makeHeartbeatPort(calls));

    expect(result.reattached).toBe(0);
    expect(result.skippedAlreadyMarked).toBe(1);
    expect(calls).toEqual([]);
  });

  it("keeps going when one dispatch fails and reports it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "hermes_gateway");
    const runOk = await createRun(db, agent, { externalRunId: "gw-run-ok" });
    await createRun(db, agent, { externalRunId: "gw-run-bad" });

    const calls: Array<{ runId: string; gatewayRunId: string }> = [];
    const heartbeat: GatewayRunReattachHeartbeatPort = {
      executeRunForGatewayReattach: async (runId, gatewayRunId) => {
        if (gatewayRunId === "gw-run-bad") throw new Error("dispatch boom");
        calls.push({ runId, gatewayRunId });
      },
    };
    const result = await sweepGatewayRunReattach(db, heartbeat);

    expect(result.failed).toBe(1);
    expect(result.reattached).toBe(1);
    expect(calls).toEqual([{ runId: runOk.id, gatewayRunId: "gw-run-ok" }]);
  });
});
