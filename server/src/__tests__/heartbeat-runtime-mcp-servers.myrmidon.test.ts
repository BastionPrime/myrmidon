import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
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
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";


const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat runtime MCP servers ignore connection health (myrmidon P9)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-heartbeat-runtime-mcp-");
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
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithConnections(healthStatuses: string[]) {
    process.env.PAPERCLIP_API_URL = "https://board.example.com";
    const [company] = await db.insert(companies).values({
      name: `Company A ${randomUUID()}`,
      issuePrefix: `MA${randomUUID().slice(0, 5).toUpperCase()}`,
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
    return { agent: agent!, connections };
  }

  it("keeps a connection whose last probe failed in the run with the same assignment", async () => {
    const { agent, connections } = await seedAgentWithConnections(["ok"]);
    const [connection] = connections;
    const first = await buildPaperclipRuntimeMcpServers({ db, agent, runId: randomUUID() });
    expect(first).toHaveLength(1);

    await db.update(toolConnections)
      .set({ healthStatus: "degraded", healthMessage: "probe failed" })
      .where(eq(toolConnections.id, connection!.id));
    const unavailableReports: Array<Array<{ id: string; name: string }>> = [];
    const degraded = await buildPaperclipRuntimeMcpServers({
      db,
      agent,
      runId: randomUUID(),
      expectedAssignmentDigest: first[0]!.connectionId.slice("assignment:".length),
      onUnavailableAssignedConnections: (reported) => {
        unavailableReports.push(reported);
      },
    });
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.connectionId).toBe(first[0]!.connectionId);
    expect(unavailableReports).toEqual([]);
  });

  it("still leaves out and reports a disabled connection", async () => {
    const { agent, connections } = await seedAgentWithConnections(["ok", "ok"]);
    await db.update(toolConnections)
      .set({ enabled: false })
      .where(eq(toolConnections.id, connections[1]!.id));
    const unavailableReports: Array<Array<{ id: string; name: string }>> = [];
    const servers = await buildPaperclipRuntimeMcpServers({
      db,
      agent,
      runId: randomUUID(),
      onUnavailableAssignedConnections: (reported) => {
        unavailableReports.push(reported);
      },
    });
    expect(servers).toHaveLength(1);
    expect(unavailableReports).toEqual([[{ id: connections[1]!.id, name: connections[1]!.name }]]);
    const [gateway] = await db.select().from(toolMcpGateways);
    const entries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, gateway!.profileId!));
    expect(entries.map((entry) => entry.connectionId)).toEqual([connections[0]!.id]);
  });

  it("keeps the native context digest and the dispatch digest equal while connections need attention", async () => {
    // The native runtime captures its MCP assignment at run start and heartbeat
    // re-derives it at dispatch; a mismatch drops every tool of the run.
    const { agent, connections } = await seedAgentWithConnections(["ok", "error", "missing_secret"]);
    const runId = randomUUID();
    const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent, runId });
    expect(snapshot.bindingId).toBe(`native-mcp:${runId}`);
    const servers = await buildPaperclipRuntimeMcpServers({
      db,
      agent,
      runId,
      expectedAssignmentDigest: snapshot.digest,
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.connectionId).toBe(`assignment:${snapshot.digest}`);
    const [gateway] = await db.select().from(toolMcpGateways);
    const entries = await db.select().from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, gateway!.profileId!));
    expect(entries.map((entry) => entry.connectionId).sort()).toEqual(
      connections.map((connection) => connection.id).sort(),
    );
  });
});
