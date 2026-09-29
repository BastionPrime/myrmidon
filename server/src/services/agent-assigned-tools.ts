/**
 * Myrmidon (BOARD-TOOLS-A): the agent's assigned MCP tool set.
 *
 * Extracted verbatim from `server/src/services/heartbeat.ts`
 * (`buildPaperclipRuntimeMcpServers`) with no behaviour change, so heartbeat and
 * the bot-container profile compiler (PR-2) resolve the same assignment digest
 * and the same immutable `native:<agentId>:<digest>` profile from one module.
 *
 * Keep this module in sync with the native runtime-context selection
 * (`native-runtime/runtime-context.ts`): native runs compare the digests of
 * both sides, so the selection rule must stay identical.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  toolConnections,
  toolMcpGateways,
  toolProfiles,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
// myrmidon(P9): run MCP selection ignores connection health
import { isRunSelectableConnection, isRunUnavailableConnection } from "../myrmidon/tool-gateway-run-selection.js";
import { filterResolvedGitHubConnectionsForRun } from "./git-credentials.js";
import type { AdapterRuntimeMcpServer } from "../adapters/index.js";
import { createToolGatewayService } from "./tool-gateway.js";
import { toolAccessService } from "./tool-access.js";

function configuredPaperclipApiBaseUrl(): string | null {
  const configured =
    typeof process.env.PAPERCLIP_API_URL === "string" &&
    process.env.PAPERCLIP_API_URL.trim().length > 0
      ? process.env.PAPERCLIP_API_URL
      : null;
  return configured
    ? configured.replace(/\/+$/, "").replace(/\/api$/, "")
    : null;
}

function paperclipApiBaseUrl(): string {
  const configured = configuredPaperclipApiBaseUrl();
  if (!configured) {
    throw new Error(
      "PAPERCLIP_API_URL is required to deliver managed runtime MCP servers",
    );
  }
  return configured;
}

/**
 * Resolve the agent's assigned MCP connections and provision the immutable
 * per-assignment profile, the aggregate gateway and the run-scoped token.
 *
 * Returns the single `paperclip-assigned` runtime MCP server, or `[]` when the
 * agent has no selectable assignment or the digest drifted from the immutable
 * context captured at run start (`expectedAssignmentDigest`).
 */
export async function resolveAgentAssignedToolSet(input: {
  db: Db;
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name">;
  runId: string;
  expectedAssignmentDigest?: string | null;
  onUnavailableAssignedConnections?: (
    connections: Array<{ id: string; name: string }>,
  ) => void | Promise<void>;
}): Promise<AdapterRuntimeMcpServer[]> {
  const access = toolAccessService(input.db);
  const effective = await access.getEffectiveProfilesForAgent(
    input.agent.companyId,
    input.agent.id,
  );
  const [runIdentity] = await input.db
    .select({
      responsibleUserId: heartbeatRuns.responsibleUserId,
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.agent.companyId),
        eq(heartbeatRuns.agentId, input.agent.id),
      ),
    )
    .limit(1);
  const resolvedInstalledConnections = runIdentity?.activeIdentityContextId
    ? effective.installedConnections
    : await filterResolvedGitHubConnectionsForRun({
        db: input.db,
        companyId: input.agent.companyId,
        agentId: input.agent.id,
        responsibleUserId: runIdentity?.responsibleUserId ?? null,
        connections: effective.installedConnections,
      });
  const permittedConnectionIds = new Set([
    ...effective.entries
      .filter((entry) => entry.effect === "include" && entry.connectionId)
      .map((entry) => entry.connectionId!),
    ...effective.allowedTools.map((tool) => tool.connectionId),
  ]);
  const allInstalledConnectionIds = new Set(
    effective.installedConnections.map((connection) => connection.id),
  );
  const permittedConnections =
    permittedConnectionIds.size > 0
      ? await input.db
          .select({
            id: toolConnections.id,
            name: toolConnections.name,
            transport: toolConnections.transport,
          })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, input.agent.companyId),
              inArray(toolConnections.id, [...permittedConnectionIds]),
            ),
          )
      : [];
  const permittedNotInstalledConnections = permittedConnections
    .filter(
      (connection) =>
        (connection.transport === "mcp_remote" ||
          connection.transport === "local_stdio") &&
        !allInstalledConnectionIds.has(connection.id),
    )
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // myrmidon(P9): health is not a filter; an assigned connection stays in the run
  // unless it is disabled or inactive (same rule as native runtime-context).
  const assignedConnections = resolvedInstalledConnections.filter(
    (connection) => permittedConnectionIds.has(connection.id) && isRunSelectableConnection(connection),
  );
  const unhealthyConnections = resolvedInstalledConnections.filter(
    (connection) => permittedConnectionIds.has(connection.id) && isRunUnavailableConnection(connection),
  );
  if (unhealthyConnections.length && input.onUnavailableAssignedConnections) {
    try {
      await input.onUnavailableAssignedConnections(
        unhealthyConnections
          .map(({ id, name }) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch (error) {
      logger.warn(
        {
          companyId: input.agent.companyId,
          agentId: input.agent.id,
          runId: input.runId,
          err: error,
        },
        "failed to report unavailable runtime MCP connections",
      );
    }
  }
  const assignedConnectionIds = new Set(
    assignedConnections.map((connection) => connection.id),
  );
  const assignedTools = effective.allowedTools.filter((tool) =>
    assignedConnectionIds.has(tool.connectionId),
  );
  const service = createToolGatewayService(input.db);
  if (assignedConnections.length === 0) {
    await service.recordRuntimeMcpDeliveryDiagnostic({
      companyId: input.agent.companyId,
      agentId: input.agent.id,
      runId: input.runId,
      permittedNotInstalledConnections,
    });
    return [];
  }
  const assignment = {
    version: 1,
    agentId: input.agent.id,
    connections: assignedConnections.map((connection) => connection.id).sort(),
    tools: assignedTools.map((tool) => tool.id).sort(),
  };
  const assignmentDigest = createHash("sha256")
    .update(JSON.stringify(assignment))
    .digest("hex");
  // Native runs may lose access after their immutable context is captured, but
  // they must never gain a new or changed assignment during dispatch.
  if (
    input.expectedAssignmentDigest !== undefined &&
    input.expectedAssignmentDigest !== assignmentDigest
  ) {
    return [];
  }
  const profile = await ensureAssignedProfile(input, {
    assignmentDigest,
    assignedConnections,
    assignedTools,
    effective,
    access,
  });

  let [gateway] = (
    await input.db
      .select()
      .from(toolMcpGateways)
      .where(
        and(
          eq(toolMcpGateways.companyId, input.agent.companyId),
          eq(toolMcpGateways.status, "active"),
          isNull(toolMcpGateways.archivedAt),
        ),
      )
  ).filter(
    (candidate) =>
      candidate.metadata?.nativeRuntimeAssignmentDigest === assignmentDigest,
  );
  if (!gateway) {
    const slug = `native-${input.agent.id.replaceAll("-", "").slice(0, 12)}-${assignmentDigest.slice(0, 16)}`;
    try {
      const created = await service.createNamedGateway({
        companyId: input.agent.companyId,
        body: {
          name: `Native ${input.agent.name} ${assignmentDigest.slice(0, 8)}`,
          slug,
          description: "Run-scoped Paperclip Runner MCP gateway.",
          profileId: profile!.id,
          defaultProfileMode: "gateway_only",
          metadata: {
            nativeRuntimeAssignmentDigest: assignmentDigest,
            agentId: input.agent.id,
          },
        },
        actor: { agentId: input.agent.id },
      });
      [gateway] = await input.db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.id, created.id))
        .limit(1);
    } catch (error) {
      [gateway] = await input.db
        .select()
        .from(toolMcpGateways)
        .where(
          and(
            eq(toolMcpGateways.companyId, input.agent.companyId),
            eq(toolMcpGateways.slug, slug),
          ),
        )
        .limit(1);
      if (!gateway) throw error;
    }
  }

  const token = await service.createNamedGatewayToken({
    companyId: input.agent.companyId,
    gatewayId: gateway!.id,
    body: {
      name: `Run ${input.runId.slice(0, 8)}`,
      subjectType: "heartbeat_run",
      subjectId: input.runId,
      clientLabel: `${input.agent.name} heartbeat run`,
      ownerNote: `Short-lived runtime MCP token for heartbeat run ${input.runId}.`,
      allowedActions: ["tools/list", "tools/call"],
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    },
    actor: { agentId: input.agent.id },
  });

  return [
    {
      name: "paperclip-assigned",
      url: `${paperclipApiBaseUrl()}/mcp/gateways/${gateway!.gatewayPublicId}`,
      token: token.token,
      connectionId: `assignment:${assignmentDigest}`,
    },
  ];
}

/**
 * Find or create the immutable assignment profile
 * `native:<agentId>:<assignmentDigest>` with default deny. The profile is
 * addressed by `profileKey`, so a concurrent creator is reconciled by re-read
 * and the original error is re-thrown when the key is still missing.
 */
async function ensureAssignedProfile(
  input: {
    db: Db;
    agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name">;
  },
  resolved: {
    assignmentDigest: string;
    assignedConnections: Array<{
      id: string;
      applicationId: string | null;
    }>;
    assignedTools: Array<{
      id: string;
      applicationId: string | null;
      connectionId: string;
    }>;
    effective: Awaited<
      ReturnType<
        ReturnType<typeof toolAccessService>["getEffectiveProfilesForAgent"]
      >
    >;
    access: ReturnType<typeof toolAccessService>;
  },
): Promise<typeof toolProfiles.$inferSelect | undefined> {
  const { assignmentDigest, assignedConnections, assignedTools, effective, access } = resolved;
  const profileKey = `native:${input.agent.id}:${assignmentDigest}`;
  let [profile] = await input.db
    .select()
    .from(toolProfiles)
    .where(
      and(
        eq(toolProfiles.companyId, input.agent.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ),
    )
    .limit(1);

  if (!profile) {
    const fullConnectionIds = new Set(
      effective.entries
        .filter(
          (entry) =>
            entry.effect === "include" &&
            entry.selectorType === "connection" &&
            entry.connectionId,
        )
        .map((entry) => entry.connectionId!),
    );
    const entries = [
      ...assignedConnections
        .filter((connection) => fullConnectionIds.has(connection.id))
        .map((connection) => ({
          selectorType: "connection" as const,
          effect: "include" as const,
          applicationId: connection.applicationId,
          connectionId: connection.id,
        })),
      ...assignedTools
        .filter((tool) => !fullConnectionIds.has(tool.connectionId))
        .map((tool) => ({
          selectorType: "catalog_entry" as const,
          effect: "include" as const,
          applicationId: tool.applicationId,
          connectionId: tool.connectionId,
          catalogEntryId: tool.id,
        })),
    ];
    // The 250-entry limit bounds a public profile-edit request, not the
    // effective assignment assembled from existing profiles. Keep every exact
    // selector here: truncating or replacing them with connection-wide grants
    // would either lose assigned tools or authorize tools outside this snapshot.
    try {
      const created = await access.createProfile(input.agent.companyId, {
        profileKey,
        name: `Native ${input.agent.id.slice(0, 8)} ${assignmentDigest.slice(0, 12)}`,
        description: "Immutable Paperclip Runner MCP assignment profile.",
        status: "active",
        defaultAction: "deny",
        metadata: {
          source: "paperclip_runner",
          agentId: input.agent.id,
          assignmentDigest,
        },
        entries,
      });
      [profile] = await input.db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.id, created.id))
        .limit(1);
    } catch (error) {
      [profile] = await input.db
        .select()
        .from(toolProfiles)
        .where(
          and(
            eq(toolProfiles.companyId, input.agent.companyId),
            eq(toolProfiles.profileKey, profileKey),
          ),
        )
        .limit(1);
      if (!profile) throw error;
    }
  }
  return profile;
}
