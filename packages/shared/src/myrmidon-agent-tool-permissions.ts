/**
 * Myrmidon (S6): per-agent tool and connection permissions.
 *
 * An agent record may carry an explicit permission under `permissions.toolAccess`.
 * The value is read on every board tool call that carries an agent, and a call is
 * refused when the tool (or its connection) is not permitted. Least privilege is
 * what the permission is for, so `mode: "listed"` is an allow-list: anything not
 * named there is refused.
 *
 * An absent or malformed value is the explicit default `mode: "all"`: an agent that
 * was never configured keeps exactly the behaviour it had before this feature.
 */

/** How an agent's tool permission treats what is not named. */
export type AgentToolPermissionMode = "all" | "listed";

export interface AgentToolPermissions {
  /** `all` — every tool the rest of the stack allows; `listed` — only what is named below. */
  mode: AgentToolPermissionMode;
  /** Gateway tool names permitted when the mode is `listed`. */
  tools: string[];
  /** Connection ids whose every tool is permitted when the mode is `listed`. */
  connections: string[];
}

/** What a single tool call is evaluated against. */
export interface AgentToolPermissionTarget {
  /** The gateway tool name the call asks for. */
  toolName: string;
  /** The catalog entry id, when the call names a connected MCP tool. */
  catalogEntryId?: string | null;
  /** The connection the tool belongs to, when it belongs to one. */
  connectionId?: string | null;
}

/** The key of the permission inside the agent's `permissions` object. */
export const AGENT_TOOL_PERMISSIONS_KEY = "toolAccess";

/** The value that means "no per-tool restriction": the previous behaviour. */
export const ALLOW_ALL_AGENT_TOOL_PERMISSIONS: AgentToolPermissions = {
  mode: "all",
  tools: [],
  connections: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** A stored value, normalised: anything unreadable becomes the allow-all default. */
export function normalizeAgentToolPermissions(value: unknown): AgentToolPermissions {
  const record = asRecord(value);
  if (!record) return { ...ALLOW_ALL_AGENT_TOOL_PERMISSIONS };
  if (record.mode !== "listed") {
    return { ...ALLOW_ALL_AGENT_TOOL_PERMISSIONS };
  }
  return {
    mode: "listed",
    tools: stringList(record.tools),
    connections: stringList(record.connections),
  };
}

/** The tool permission an agent record carries, normalised. */
export function readAgentToolPermissions(permissions: unknown): AgentToolPermissions {
  const record = asRecord(permissions);
  return normalizeAgentToolPermissions(record?.[AGENT_TOOL_PERMISSIONS_KEY]);
}

/** True when the agent's permission lets this call through. */
export function agentToolPermissionAllows(
  permissions: AgentToolPermissions,
  target: AgentToolPermissionTarget,
): boolean {
  if (permissions.mode !== "listed") return true;
  const names = [target.toolName, target.catalogEntryId ?? ""].filter((name) => name.length > 0);
  if (names.some((name) => permissions.tools.includes(name))) return true;
  const connectionId = target.connectionId ?? "";
  return connectionId.length > 0 && permissions.connections.includes(connectionId);
}