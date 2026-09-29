import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { listBotContainerAgents } from "./agents-query.js";

const CONTAINER = { enabled: true, image: "myrmidon-hermes:1.1.0", memoryMb: 512, cpus: 1, pidsLimit: 128 };

describe("listBotContainerAgents query shape", () => {
  function fakeDb(rows: unknown[]) {
    const captured: { fields?: Record<string, unknown>; where?: SQL } = {};
    const chain = {
      select(fields: Record<string, unknown>) {
        captured.fields = fields;
        return chain;
      },
      from() {
        return chain;
      },
      where(condition: SQL) {
        captured.where = condition;
        return chain;
      },
      then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return { db: chain as unknown as Db, captured };
  }

  it("filters by adapter, status and container.enabled in the database", async () => {
    const { db, captured } = fakeDb([]);
    await expect(listBotContainerAgents(db)()).resolves.toEqual([]);

    const rendered = new PgDialect().sqlToQuery(captured.where!);
    expect(rendered.params).toEqual(["hermes_gateway", "terminated"]);
    expect(rendered.sql).toMatch(/"adapter_type" = \$1/);
    expect(rendered.sql).toMatch(/"status" <> \$2/);
    expect(rendered.sql).toMatch(/"adapter_config" #> '\{container,enabled\}' = 'true'::jsonb/);
  });

  it("reads the container sub-object, not the whole adapterConfig", async () => {
    const { db, captured } = fakeDb([]);
    await listBotContainerAgents(db)();

    expect(Object.keys(captured.fields ?? {}).sort()).toEqual(["adapterType", "agentId", "container"]);
    expect(captured.fields?.container).not.toBe(agents.adapterConfig);
  });

  it("returns each row as an agent whose card carries only the container block", async () => {
    const id = randomUUID();
    const { db } = fakeDb([{ agentId: id, adapterType: "hermes_gateway", container: CONTAINER }]);
    await expect(listBotContainerAgents(db)()).resolves.toEqual([
      { agentId: id, adapterType: "hermes_gateway", adapterConfig: { container: CONTAINER } },
    ]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("listBotContainerAgents against a database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-bot-containers-agents-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(overrides: Partial<typeof agents.$inferInsert>) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: { container: CONTAINER },
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return agentId;
  }

  it("returns only the enabled hermes_gateway agents that are not terminated", async () => {
    const enabled = await seedAgent({});
    const paused = await seedAgent({ status: "paused" });
    const withLongCard = await seedAgent({
      adapterConfig: { instructions: "x".repeat(5000), env: { A: "b" }, container: CONTAINER },
    });
    await seedAgent({ status: "terminated" });
    await seedAgent({ adapterConfig: { container: { ...CONTAINER, enabled: false } } });
    await seedAgent({ adapterConfig: { container: { ...CONTAINER, enabled: "true" } } });
    await seedAgent({ adapterConfig: { container: { image: CONTAINER.image } } });
    await seedAgent({ adapterConfig: { model: "some-model" } });
    await seedAgent({ adapterConfig: {} });
    await seedAgent({ adapterType: "process" });

    const listed = await listBotContainerAgents(db as unknown as Db)();

    expect(listed.map((a) => a.agentId).sort()).toEqual([enabled, paused, withLongCard].sort());
    for (const agent of listed) {
      expect(agent.adapterType).toBe("hermes_gateway");
      // A parsed object, and nothing but the container block.
      expect(agent.adapterConfig).toEqual({ container: CONTAINER });
    }
  });
});
