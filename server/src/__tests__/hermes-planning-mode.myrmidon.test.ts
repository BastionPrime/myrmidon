import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// X2: the vendor planning work mode reaches the prompt of a hermes_local run.
const spawned = vi.hoisted(() => ({ stdin: [] as string[] }));
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], opts: { stdin?: string }) => {
      spawned.stdin.push(opts.stdin ?? "");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
    }),
  };
});

import { execute } from "@paperclipai/hermes-paperclip-adapter/server";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("hermes_local in planning work mode (X2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-planning-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    spawned.stdin.length = 0;
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(workMode: "planning" | "standard") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plan the release",
      description: "Work out the release steps.",
      status: "todo",
      priority: "medium",
      workMode,
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  async function runHermes(input: { companyId: string; agentId: string; issueId: string }) {
    const contextSnapshot = { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_assigned" };
    const paperclipWake = await buildPaperclipWakePayload({
      db,
      companyId: input.companyId,
      agentId: input.agentId,
      contextSnapshot,
    });
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-x2-hermes-"));
    tempDirs.push(home);
    await fs.writeFile(path.join(home, "config.yaml"), "model:\n  default: test-model\n", "utf8");
    await execute({
      runId: "run-a",
      agent: { id: input.agentId, companyId: input.companyId, name: "agent-a", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "/usr/bin/hermes",
        provider: "custom",
        quiet: true,
        timeoutSec: 60,
        graceSec: 5,
        env: { HERMES_HOME: home },
      },
      context: { ...contextSnapshot, paperclipWake },
      onLog: async () => {},
    } as never);
    expect(spawned.stdin).toHaveLength(1);
    return spawned.stdin[0]!;
  }

  it("puts the planning directive into the prompt of a planning task", async () => {
    const prompt = await runHermes(await seed("planning"));
    expect(prompt).toContain("- issue work mode: planning");
    expect(prompt).toContain("- planning directive: Make the plan only. Do not write code or perform implementation work.");
  });

  it("leaves the planning directive out of a standard task", async () => {
    const prompt = await runHermes(await seed("standard"));
    expect(prompt).not.toContain("planning directive");
  });
});
