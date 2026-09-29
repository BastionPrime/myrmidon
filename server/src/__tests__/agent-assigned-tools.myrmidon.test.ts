import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  connectionGrants,
  createDb,
  heartbeatRuns,
  toolAccessAuditEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolCatalogEntries,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
// myrmidon(BOARD-TOOLS-A): guard the extracted assignment resolver
import { resolveAgentAssignedToolSet } from "../services/agent-assigned-tools.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent-assigned tool set matches the heartbeat digest and slug (myrmidon BOARD-TOOLS-A)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-agent-assigned-tools-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await db.delete(toolMcpGatewayTokens);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(heartbeatRuns);
    await db.delete(toolMcpGateways);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithConnections(healthStatuses: string[]) {
    process.env.PAPERCLIP_API_URL = "https://board.example.com";
    const [company] = await db.insert(companies).values({
      name: `Company A ${randomUUID()}`,
      issuePrefix: `BA${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "agent-a",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `app-${randomUUID().slice(0, 8)}`,
      name: "App A",
      type: "mcp_http",
      status: "active",
    }).returning();
    const connections = await db.insert(toolConnections).values(
      healthStatuses.map((healthStatus, index) => ({
        companyId: company!.id,
        applicationId: application!.id,
        name: `Connection ${index} ${healthStatus}`,
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote" as const,
        status: "active" as const,
        enabled: true,
        healthStatus: healthStatus as "ok",
        config: { url: `https://mcp-${index}.example.com/mcp` },
      })),
    ).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id,
      profileKey: `profile:${randomUUID()}`,
      name: "Profile A",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values(connections.map((connection) => ({
      companyId: company!.id,
      profileId: profile!.id,
      selectorType: "connection" as const,
      effect: "include" as const,
      applicationId: application!.id,
      connectionId: connection.id,
    })));
    await db.insert(toolProfileBindings).values({
      companyId: company!.id,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agent!.id,
    });
    await db.insert(toolConnectionInstalls).values(connections.map((connection) => ({
      companyId: company!.id,
      connectionId: connection.id,
      targetType: "agent" as const,
      targetId: agent!.id,
    })));
    return { agent: agent!, company: company!, connections };
  }

  it("resolves the same digest, profile key and native- gateway slug as the heartbeat path", async () => {
    const { agent, connections } = await seedAgentWithConnections(["ok", "error"]);
    const runId = randomUUID();

    // Reference values: the same inputs through the vendor export that heartbeat
    // call sites use, and the native context snapshot digest from run start.
    const reference = await buildPaperclipRuntimeMcpServers({ db, agent, runId });
    expect(reference).toHaveLength(1);
    const digest = reference[0]!.connectionId.slice("assignment:".length);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    const resolved = await resolveAgentAssignedToolSet({
      db,
      agent,
      runId: randomUUID(),
      expectedAssignmentDigest: digest,
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("paperclip-assigned");
    expect(resolved[0]!.connectionId).toBe(`assignment:${digest}`);

    // The immutable profile key and the aggregate gateway slug keep the exact
    // pre-refactor shapes: native:<agentId>:<digest> and native-<agent>-<digest>.
    const [gateway] = await db.select().from(toolMcpGateways);
    expect(gateway!.slug).toBe(
      `native-${agent.id.replaceAll("-", "").slice(0, 12)}-${digest.slice(0, 16)}`,
    );
    const assignment = {
      version: 1,
      agentId: agent.id,
      connections: connections.map((connection) => connection.id).sort(),
      tools: [] as string[],
    };
    const expectedDigest = (await import("node:crypto"))
      .createHash("sha256")
      .update(JSON.stringify(assignment))
      .digest("hex");
    expect(digest).toBe(expectedDigest);
    const [nativeProfile] = await db
      .select()
      .from(toolProfiles)
      .where(eq(toolProfiles.profileKey, `native:${agent.id}:${digest}`));
    expect(nativeProfile).toBeTruthy();
    expect(nativeProfile!.defaultAction).toBe("deny");
    expect(nativeProfile!.metadata).toMatchObject({
      source: "paperclip_runner",
      agentId: agent.id,
      assignmentDigest: digest,
    });

    // Both sides must keep deriving the identical assignment: the native
    // runtime-context snapshot (run start) and the resolver (dispatch).
    const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent, runId });
    expect(snapshot.digest).toBe(digest);
  });

  it("drops every server when the expected digest does not match", async () => {
    const { agent } = await seedAgentWithConnections(["ok"]);
    const resolved = await resolveAgentAssignedToolSet({
      db,
      agent,
      runId: randomUUID(),
      expectedAssignmentDigest: "0".repeat(64),
    });
    expect(resolved).toEqual([]);
    expect(await db.select().from(toolMcpGateways)).toHaveLength(0);
  });

  it("returns no servers and audits when the agent has no installed connections", async () => {
    process.env.PAPERCLIP_API_URL = "https://board.example.com";
    const [company] = await db.insert(companies).values({
      name: `Company B ${randomUUID()}`,
      issuePrefix: `BB${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "agent-b",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
    }).returning();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    });

    const resolved = await resolveAgentAssignedToolSet({ db, agent, runId });

    expect(resolved).toEqual([]);
  });
});
