/**
 * X8 bridged direct-message command contract (agent-chat-bridge).
 *
 * A bridged Telegram direct message that starts with a `/command` is
 * intercepted before it reaches the agent, OpenClaw-style: `/new` resets the
 * session, `/model` switches it, `/stop` cancels the running reply, and so
 * on. This module defines the shared shape; X8a wires up only `/new` and
 * `/reset` as a minimal, behavior-preserving stand-in. X8c replaces the body
 * of `runBridgedDirectMessageCommand` with the full command set, keeping
 * these signatures.
 */

import type { Db } from "@paperclipai/db";

export interface BridgedCommandInput {
  db: Db;
  companyId: string;
  /** chat_endpoints.assigned_agent_id */
  agentId: string;
  endpointId: string;
  /** chat_deliveries.id of this message */
  deliveryId: string;
  /** Linked board user of the sender */
  boardUserId: string;
  /** The Telegram conversation issue; X8b guarantees it exists */
  conversationIssueId: string;
  /** Raw provider text */
  text: string;
  publicBaseUrl: string | null;
  cancelRun: (
    runId: string,
    reason: string,
    options: { errorCode?: string; resultJson?: Record<string, unknown> },
  ) => Promise<unknown>;
}

export type BridgedCommandResult =
  | { kind: "reply"; command: string; text: string }
  | { kind: "message"; body: string; notice?: string }
  | null;

export interface BridgedCommandSpec {
  command: string;
  description: string;
}

export const TELEGRAM_DM_COMMANDS: readonly BridgedCommandSpec[] = [
  { command: "help", description: "Show commands" },
  { command: "new", description: "Start a new session (optional: /new <model>)" },
  { command: "model", description: "Show or switch the model for this chat" },
  { command: "think", description: "Show or set reasoning effort" },
  { command: "stop", description: "Stop the current reply" },
  { command: "status", description: "Show model, session and current reply" },
];

const BRIDGED_COMMAND_PATTERN = /^\/([a-z][\w-]*)(?:@[\w.]+)?(?:\s+([\s\S]*))?$/i;

/**
 * Parses a `/command[@bot] [args]` message. Returns null for anything that
 * is not a command, including a slash mid-path like `/home/x` (the name
 * must be followed by whitespace or the end of the string).
 */
export function parseBridgedCommand(text: string): { name: string; args: string } | null {
  const match = BRIDGED_COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * Minimal X8a implementation: `/new` and `/reset` fall through to the
 * vendor's own `/new` handling (posted as an ordinary comment body so the
 * usual session-reset path runs); every other command is left unhandled
 * (null) until X8c fills them in.
 */
export async function runBridgedDirectMessageCommand(
  input: BridgedCommandInput,
): Promise<BridgedCommandResult> {
  const parsed = parseBridgedCommand(input.text);
  if (!parsed) return null;
  if (parsed.name === "new" || parsed.name === "reset") {
    return { kind: "message", body: "/new" };
  }
  return null;
}
