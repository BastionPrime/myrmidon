import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolCallEvents,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import {
  agentToolPermissionAllows,
  normalizeAgentToolPermissions,
  readAgentToolPermissions,
} from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** A built-in gateway tool that needs no connection, so the only gate under test is the permission. */
const FIXTURE_TOOL = "mcp-remote-fixture:echo";

type Db = ReturnType<typeof createDb>;

describe("myrmidon(S6) agent tool permission model", () => {
  it("treats an absent or malformed permission as allow-all", () => {
    expect(readAgentToolPermissions({})).toEqual({ mode: "all", tools: [], connections: [] });
    expect(readAgentToolPermissions(undefined)).toEqual({ mode: "all", tools: [], connections: [] });
    expect(readAgentToolPermissions({ toolAccess: { mode: "listed" } })).toEqual({
      mode: "listed",
      tools: [],
      connections: [],
    });
    expect(readAgentToolPermissions({ toolAccess: "nonsense" })).toEqual({
      mode: "all",
      tools: [],
      connections: [],
    });
    expect(
      normalizeAgentToolPermissions({ mode: "listed", tools: [" a ", "a", 5], connections: null }),
    ).toEqual({ mode: "listed", tools: ["a"], connections: [] });
  });

  it("allows everything in the all mode and only named tools in the listed mode", () => {
    expect(agentToolPermissionAllows({ mode: "all", tools: [], connections: [] }, { toolName: "x" })).toBe(true);
    const listed = { mode: "listed" as const, tools: ["x"], connections: ["c1"] };
    expect(agentToolPermissionAllows(listed, { toolName: "x" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "y", connectionId: "c1" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "y", catalogEntryId: "x" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "y", connectionId: "c2" })).toBe(false);
    expect(agentToolPermissionAllows(listed, { toolName: "y" })).toBe(false);
  });
});

describeEmbeddedPostgres("myrmidon(S6) agent tool permission enforcement", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-tool-permissions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db
      .insert(companies)
      .values({
        name: `Tool permission ${randomUUID()}`,
        issuePrefix: `ATP${randomUUID().slice(0, 5).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createAgent(companyId: string, permissions: Record<string, unknown>) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** A running run: the session of a bot or a host run is bound to it (A2). */
  async function createRunningRun(companyId: string, agentId: string) {
    const project = await db
      .insert(projects)
      .values({ companyId, name: `Project ${randomUUID()}` })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: `Issue ${randomUUID()}`,
        status: "in_progress",
        assigneeAgentId: agentId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: issue.id, projectId: project.id },
      })
      .returning()
      .then((rows) => rows[0]!);
    return { project, issue, run };
  }

  /** An allow-all profile, so the only thing that can deny the call is the agent permission. */
  async function allowAllToolsForAgent(companyId: string, agentId: string) {
    const profile = await db
      .insert(toolProfiles)
      .values({
        companyId,
        profileKey: `permission-all-${randomUUID()}`,
        name: `All ${randomUUID()}`,
        defaultAction: "allow",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .insert(toolProfileBindings)
      .values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId });
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: profile.id,
      selectorType: "tool_name" as const,
      effect: "include" as const,
      toolName: FIXTURE_TOOL,
    });
    return profile;
  }

  function createGateway() {
    return createToolGatewayService(db, { toolActionSigningSecret: "test-tool-action-signing-secret" });
  }

  it("refuses a tool the agent's list does not name, and writes it to the journal", async () => {
    const company = await createCompany();
    const agent = await createAgent(company.id, { toolAccess: { mode: "listed", tools: [], connections: [] } });
    const { run } = await createRunningRun(company.id, agent.id);
    await allowAllToolsForAgent(company.id, agent.id);
    const gateway = createGateway();
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    expect(session.runId).toBe(run.id);

    await expect(gateway.listToolsForSession(session.token)).resolves.toEqual([]);

    await gateway
      .executeTool({ sessionToken: session.token, tool: FIXTURE_TOOL, parameters: { message: "denied" } })
      .then(
        () => {
          throw new Error("Expected the tool call to be refused");
        },
        (error) => {
          expect(error).toBeInstanceOf(ToolGatewayHttpError);
          expect((error as ToolGatewayHttpError).status).toBe(403);
          expect((error as ToolGatewayHttpError).reasonCode).toBe("deny_agent_permission");
        },
      );

    const denials = await db
      .select()
      .from(toolCallEvents)
      .where(eq(toolCallEvents.reasonCode, "deny_agent_permission"));
    expect(denials.map((row) => row.agentId)).toContain(agent.id);
    expect(denials.map((row) => row.decision)).toContain("deny");
    expect(denials.map((row) => row.runId)).toContain(run.id);
  });

  it("lets a named tool through and leaves an agent without the permission unchanged", async () => {
    const company = await createCompany();
    const gateway = createGateway();

    const listedAgent = await createAgent(company.id, { toolAccess: { mode: "listed", tools: [FIXTURE_TOOL] } });
    const listedRun = await createRunningRun(company.id, listedAgent.id);
    await allowAllToolsForAgent(company.id, listedAgent.id);
    const listedSession = await gateway.createSession({
      companyId: company.id,
      agentId: listedAgent.id,
      runId: listedRun.run.id,
    });
    await expect(
      gateway.executeTool({ sessionToken: listedSession.token, tool: FIXTURE_TOOL, parameters: { message: "allowed" } }),
    ).resolves.toMatchObject({ tool: FIXTURE_TOOL });

    const unsetAgent = await createAgent(company.id, {});
    const unsetRun = await createRunningRun(company.id, unsetAgent.id);
    await allowAllToolsForAgent(company.id, unsetAgent.id);
    const unsetSession = await gateway.createSession({
      companyId: company.id,
      agentId: unsetAgent.id,
      runId: unsetRun.run.id,
    });
    await expect(
      gateway.executeTool({ sessionToken: unsetSession.token, tool: FIXTURE_TOOL, parameters: { message: "unchanged" } }),
    ).resolves.toMatchObject({ tool: FIXTURE_TOOL });
  });
});