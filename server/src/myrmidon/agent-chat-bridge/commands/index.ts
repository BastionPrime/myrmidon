// myrmidon(X8c): OpenClaw-style commands in a bridged Telegram direct
// message conversation: /help, /new, /model, /think, /stop, /status, plus
// the compatibility replies /close and /task.
//
// The exported interface here (BridgedCommandInput, BridgedCommandResult,
// BridgedCommandSpec, TELEGRAM_DM_COMMANDS, parseBridgedCommand,
// runBridgedDirectMessageCommand) is the X8 contract; X8b calls it. See
// identity.ts's header for why this PR carries its own copy of the parts of
// the contract that X8a also owns.

import type { Db } from "@paperclipai/db";
import { CHAT_NOT_AVAILABLE_TEXT, loadBridgedCommandContext, type BridgedCommandContext } from "./context.js";
import { buildHelpText } from "./help.js";
import {
  MODEL_CHOOSER,
  THINK_CHOOSER,
  checkChooserAvailability,
  describeCardValue,
  describeEffectiveChatValue,
  formatChatChoiceList,
  readOverrideAdapterConfig,
  resolveChooserSelection,
  type ChatModelChooser,
} from "./models.js";
import { applyChatAdapterOverride } from "./overrides.js";
import { buildChatStatusReply } from "./status.js";
import { stopBridgedChatRuns } from "./stop.js";

export interface BridgedCommandInput {
  db: Db;
  companyId: string;
  agentId: string;
  endpointId: string;
  deliveryId: string;
  boardUserId: string;
  conversationIssueId: string;
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
  { command: "help", description: "Show this list of commands" },
  { command: "new", description: "Start a new session, optionally with a model" },
  { command: "model", description: "Show or change the model for this chat" },
  { command: "think", description: "Show or change the reasoning effort for this chat" },
  { command: "stop", description: "Stop the reply in progress" },
  { command: "status", description: "Show chat, model and session status" },
];

const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  start: "help",
  commands: "help",
  reset: "new",
};

const COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/;

/**
 * Longest command name echoed back in reply text (e.g. "Unknown command
 * /<name>."). `parsed.name` is untrusted chat input and COMMAND_PATTERN
 * does not bound its length, so it is truncated before display. This is
 * separate from the `command` result field itself, which never carries
 * unvalidated chat input at all — see the two call sites below.
 */
const MAX_DISPLAYED_COMMAND_NAME_LENGTH = 64;

function truncateForDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Parses `/name[@bot] [args]`. Case-insensitive; `/home/x` is not a command
 * (a slash must be followed by whitespace or the end of the message).
 */
export function parseBridgedCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = COMMAND_PATTERN.exec(trimmed);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

export async function runBridgedDirectMessageCommand(
  input: BridgedCommandInput,
): Promise<BridgedCommandResult> {
  const parsed = parseBridgedCommand(input.text);
  if (!parsed) return null;
  const name = COMMAND_ALIASES[parsed.name] ?? parsed.name;

  const context = await loadBridgedCommandContext(input.db, {
    companyId: input.companyId,
    agentId: input.agentId,
    boardUserId: input.boardUserId,
    conversationIssueId: input.conversationIssueId,
  });
  if (!context) {
    // myrmidon(X8c): `command` feeds the X8 contract's publication key
    // (`control:x8-${command}:${deliveryId}`, required to match `[a-z-]+`).
    // `name` is chat input at this point (COMMAND_ALIASES only rewrites
    // known names), so a fixed literal is used here instead of it.
    return { kind: "reply", command: "not-available", text: CHAT_NOT_AVAILABLE_TEXT };
  }

  switch (name) {
    case "help":
      return { kind: "reply", command: "help", text: buildHelpText(context.agent.name, TELEGRAM_DM_COMMANDS) };
    case "new":
      return handleNewCommand(input, context, parsed.args);
    case "model":
      return handleChooserCommand(input, context, MODEL_CHOOSER, parsed.args);
    case "think":
      return handleChooserCommand(input, context, THINK_CHOOSER, parsed.args);
    case "stop":
      return handleStopCommand(input);
    case "status":
      return handleStatusCommand(input, context);
    case "close":
      return { kind: "reply", command: "close", text: "This chat does not close. Use /new to start over." };
    case "task":
      return { kind: "reply", command: "task", text: "In a direct chat just write your request." };
    default:
      // myrmidon(X8c): same reasoning as the not-available branch above —
      // `name` is unvalidated chat input here, so `command` gets a fixed
      // literal; the original name is shown in `text` only, and truncated,
      // since COMMAND_PATTERN does not bound its length.
      return {
        kind: "reply",
        command: "unknown",
        text: `Unknown command /${truncateForDisplay(parsed.name, MAX_DISPLAYED_COMMAND_NAME_LENGTH)}. Send /help for the list.`,
      };
  }
}

async function handleNewCommand(
  input: BridgedCommandInput,
  context: BridgedCommandContext,
  args: string,
): Promise<BridgedCommandResult> {
  const modelArg = args.trim();
  if (!modelArg) {
    return { kind: "message", body: "/new", notice: "Started a new session. History stays on the board." };
  }

  const resolution = await resolveChooserSelection({
    chooser: MODEL_CHOOSER,
    agent: context.agent,
    arg: modelArg,
    turnInProgress: context.turnInProgress,
    // A model chosen with /new applies to the fresh session /new is about to
    // start, not to whatever is currently running; no need to wait for it.
    checkTurnInProgress: false,
  });
  if (resolution.kind === "error") {
    return { kind: "reply", command: "new", text: resolution.text };
  }

  const value = resolution.kind === "default" ? null : resolution.candidate.id;
  await applyChatAdapterOverride({
    db: input.db,
    companyId: input.companyId,
    conversationAgentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    key: MODEL_CHOOSER.adapterConfigKey,
    value,
  });
  const modelLabel =
    resolution.kind === "default"
      ? `agent default (${describeCardValue(context.agent.adapterConfig, MODEL_CHOOSER.adapterConfigKey)})`
      : resolution.candidate.id;
  return {
    kind: "message",
    body: "/new",
    notice: `Started a new session with model ${modelLabel}. History stays on the board.`,
  };
}

async function handleChooserCommand(
  input: BridgedCommandInput,
  context: BridgedCommandContext,
  chooser: ChatModelChooser,
  args: string,
): Promise<BridgedCommandResult> {
  const overrideAdapterConfig = readOverrideAdapterConfig(context.issue.assigneeAdapterOverrides);
  const trimmed = args.trim();

  if (!trimmed) {
    const availability = await checkChooserAvailability(chooser, context.agent);
    if (!availability.available) {
      return {
        kind: "reply",
        command: chooser.commandName,
        text: `Switching the ${chooser.noun} is not available for this agent.`,
      };
    }
    const effective = describeEffectiveChatValue(
      overrideAdapterConfig,
      context.agent.adapterConfig,
      chooser.adapterConfigKey,
    );
    return {
      kind: "reply",
      command: chooser.commandName,
      text:
        `${chooser.statusLabel}: ${effective.value} (${effective.source}).\n` +
        `Available:\n${formatChatChoiceList(availability.candidates)}\n` +
        `Use /${chooser.commandName} <name or number>, /${chooser.commandName} default.`,
    };
  }

  const resolution = await resolveChooserSelection({
    chooser,
    agent: context.agent,
    arg: trimmed,
    turnInProgress: context.turnInProgress,
    checkTurnInProgress: true,
  });
  if (resolution.kind === "error") {
    return { kind: "reply", command: chooser.commandName, text: resolution.text };
  }

  if (resolution.kind === "default") {
    await applyChatAdapterOverride({
      db: input.db,
      companyId: input.companyId,
      conversationAgentId: input.agentId,
      issueId: input.conversationIssueId,
      boardUserId: input.boardUserId,
      key: chooser.adapterConfigKey,
      value: null,
    });
    return {
      kind: "reply",
      command: chooser.commandName,
      text: `${chooser.statusLabel} for this chat: agent default (${describeCardValue(context.agent.adapterConfig, chooser.adapterConfigKey)}).`,
    };
  }

  await applyChatAdapterOverride({
    db: input.db,
    companyId: input.companyId,
    conversationAgentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    key: chooser.adapterConfigKey,
    value: resolution.candidate.id,
  });
  return {
    kind: "reply",
    command: chooser.commandName,
    text:
      `${chooser.statusLabel} for this chat: ${resolution.candidate.id}. ` +
      "The next reply starts a fresh model session with this chat's recent history.",
  };
}

async function handleStopCommand(input: BridgedCommandInput): Promise<BridgedCommandResult> {
  const result = await stopBridgedChatRuns({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    cancelRun: input.cancelRun,
  });
  const text = result.failed
    ? "Stopping is not available right now."
    : result.stopped > 0
      ? "Stopping the current reply."
      : "Nothing is running.";
  return { kind: "reply", command: "stop", text };
}

async function handleStatusCommand(
  input: BridgedCommandInput,
  context: BridgedCommandContext,
): Promise<BridgedCommandResult> {
  const text = await buildChatStatusReply({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    boardUserId: input.boardUserId,
    publicBaseUrl: input.publicBaseUrl,
    context,
  });
  return { kind: "reply", command: "status", text };
}
