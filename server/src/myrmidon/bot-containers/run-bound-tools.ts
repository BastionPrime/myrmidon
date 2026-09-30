// server/src/myrmidon/bot-containers/run-bound-tools.ts
//
// myrmidon(BOARD-TOOLS-A2): bind a bot container's gateway session to the
// agent's single active run, and serve the task/project tools through the
// same gateway. Two halves live here; the vendor call site is marked in
// tool-gateway.ts:
//
//   1. Run selection. A gateway the bot-container reconciler made (its
//      metadata carries `source: myrmidon_bot_containers`, see
//      board-gateway-ports.ts) serves a `gateway_client` token, which has no
//      run of its own. The board looks up the agent's runs in
//      ACTIVE_GATEWAY_RUN_STATUSES: exactly one active run binds the session
//      to it (run id, responsible user, task, project); zero or several
//      active runs leave the session unbound. Unbound, the agent's own
//      assigned tools keep working; task/project tools are refused.
//   2. Task/project tools. The same gateway lists and executes the project
//      tool set (create_project, list_project_repositories, list_projects,
//      create_task) for a bound session, using the same call path the native
//      runtime uses (project-tools.ts over the run's local agent JWT), so the
//      audit attributes the call to the run without touching hermes.

import { and, desc, eq, inArray } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { callProjectTool, projectToolDefinitions } from "../../services/project-tools.js";
import type { ToolGatewayDescriptor, ToolGatewaySession } from "../../services/tool-gateway.js";

/** The provider type carried by the task/project tool descriptors below. */
export const RUN_BOUND_PROJECT_PROVIDER = "paperclip_self" as const;

/** The metadata marker of a gateway made by the bot-container reconciler. */
export const BOT_GATEWAY_SOURCE_MARKER = "myrmidon_bot_containers";

/** The reason code recorded when a task/project tool is refused without a run binding. */
export const RUN_BINDING_REQUIRED_CODE = "agent_context_required";

export type RunSelection =
  | { kind: "bound"; runId: string }
  | { kind: "unbound"; activeCount: number };

/**
 * The single active run of the agent, or none. `statuses` is the gateway's own
 * notion of an active run (ACTIVE_GATEWAY_RUN_STATUSES in tool-gateway.ts):
 * one row binds, anything else does not.
 */
export async function selectBotGatewayRun(input: {
  db: Db;
  companyId: string;
  agentId: string;
  statuses: ReadonlySet<string>;
  now?: () => Date;
}): Promise<RunSelection> {
  const rows = await input.db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, [...input.statuses]),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(2);
  if (rows.length === 1) return { kind: "bound", runId: rows[0]!.id };
  return { kind: "unbound", activeCount: rows.length };
}

/** Task/project tool descriptors for a run-bound gateway session. */
export function runBoundProjectToolDescriptors(session: ToolGatewaySession): ToolGatewayDescriptor[] {
  // myrmidon(BOARD-TOOLS-A2): only a bot-container gateway bound to the
  // agent's single active run serves the task/project tools; any other
  // session shape (unbound bot gateway, run token of another kind) does not.
  if (session.botGatewayRunBinding !== "bound" || !session.runId || !session.issueId) return [];
  return projectToolDefinitions("standard", true).map((tool) => ({
    name: tool.name,
    displayName: tool.name,
    description: tool.description,
    parametersSchema: tool.inputSchema as Record<string, unknown>,
    pluginId: "paperclip-run-bound",
    providerType: RUN_BOUND_PROJECT_PROVIDER,
    risk: tool.name === "list_projects" || tool.name === "list_project_repositories" ? "read" : "write",
  }));
}

/** True when the tool name belongs to the run-bound task/project set. */
export function isRunBoundProjectTool(name: string): boolean {
  return runBoundProjectToolNames().includes(name);
}

function runBoundProjectToolNames(): string[] {
  return projectToolDefinitions("standard", true).map((tool) => tool.name);
}

/**
 * Execute a task/project tool for a run-bound session through the same path
 * the native runtime uses. The JWT carries the run's responsible user, so a
 * personal GitHub grant or project creation lands on the same identity the
 * run's own API calls use.
 */
export async function executeRunBoundProjectTool(input: {
  db: Db;
  session: ToolGatewaySession;
  toolName: string;
  parameters: Record<string, unknown>;
}): Promise<{ content: string; data: unknown }> {
  const { session } = input;
  if (
    session.botGatewayRunBinding !== "bound" ||
    !session.runId ||
    !session.agentId ||
    !session.issueId ||
    !session.companyId
  ) {
    throw new RunBoundToolError(
      403,
      "Task and project tools require the gateway session to be bound to one active run",
      RUN_BINDING_REQUIRED_CODE,
    );
  }
  const [run] = await input.db
    .select({
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      responsibleUserId: heartbeatRuns.responsibleUserId,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, session.runId))
    .limit(1);
  if (!run || run.companyId !== session.companyId || run.agentId !== session.agentId) {
    throw new RunBoundToolError(403, "The bound run no longer belongs to this agent", "run_inactive");
  }
  const snapshot = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  const runIssueId = run.nativeIssueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : null);
  if (!runIssueId || runIssueId !== session.issueId) {
    throw new RunBoundToolError(403, "The bound run task does not match the session task", "run_context_mismatch");
  }
  const [agentRow] = await input.db
    .select({ adapterType: agents.adapterType })
    .from(agents)
    .where(eq(agents.id, session.agentId))
    .limit(1);
  const [issue] = await input.db
    .select({ companyId: issues.companyId, workMode: issues.workMode, conversationAgentId: issues.conversationAgentId })
    .from(issues)
    .where(eq(issues.id, runIssueId))
    .limit(1);
  if (!issue || issue.companyId !== session.companyId) {
    throw new RunBoundToolError(403, "The bound run task is unavailable", "run_context_mismatch");
  }
  if (!projectToolDefinitions(issue.workMode, true).some((tool) => tool.name === input.toolName)) {
    throw new RunBoundToolError(403, "Tool is unavailable in this mode", "tool_mode_denied");
  }
  const apiUrl = process.env.PAPERCLIP_API_URL;
  if (!apiUrl) throw new RunBoundToolError(500, "Board API origin is unavailable", "api_origin_unavailable");
  const adapterType = agentRow?.adapterType || "process";
  const token = createLocalAgentJwt(
    session.agentId,
    session.companyId,
    adapterType,
    session.runId,
    run.responsibleUserId ?? session.responsibleUserId ?? null,
  );
  if (!token) throw new RunBoundToolError(500, "Project tool authentication is unavailable", "auth_unavailable");
  const result = await callProjectTool({
    name: input.toolName,
    arguments: input.parameters,
    apiUrl,
    token,
    companyId: session.companyId,
    issueId: runIssueId,
    agentId: session.agentId,
    conversation: Boolean(issue.conversationAgentId),
  });
  return { content: JSON.stringify(result), data: result };
}

/** Error shape the vendor gateway turns into its JSON-RPC error body. */
export class RunBoundToolError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reasonCode: string,
  ) {
    super(message);
  }
}
