/**
 * X8 bridged direct-message command contract (agent-chat-bridge).
 *
 * A bridged Telegram direct message that starts with a `/command` is
 * intercepted before it reaches the agent, OpenClaw-style: `/help`, `/new`,
 * `/model`, `/think`, `/stop`, `/status`, plus the compatibility replies
 * `/close` and `/task`. X8a defined this module's shared shape
 * (`BridgedCommandInput`, `BridgedCommandResult`, `BridgedCommandSpec`,
 * `TELEGRAM_DM_COMMANDS`, `parseBridgedCommand`) with a minimal, only
 * `/new`/`/reset` stand-in body for `runBridgedDirectMessageCommand`; this
 * PR (X8c) keeps those signatures and replaces the body with the full
 * command set. X8b calls it.
 *
 * myrmidon(X8-texts): every reply in this module is read by a person in the
 * bridged Telegram DM, so the prose is Russian (the pilot chat language) and
 * the command descriptions are the ones Telegram shows in its command menu.
 * Command names, model ids, reasoning levels and the `/model default` keyword
 * stay as they are — they are input, not prose.
 */

import type { Db } from "@paperclipai/db";
import { CHAT_NOT_AVAILABLE_TEXT, loadBridgedCommandContext, type BridgedCommandContext } from "./context.js";
import { buildHelpText } from "./help.js";
import {
  MODEL_CHOOSER,
  THINK_CHOOSER,
  TURN_IN_PROGRESS_TEXT,
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
  { command: "help", description: "Показать команды" },
  { command: "new", description: "Начать новую сессию (необязательно: /new <модель>)" },
  { command: "model", description: "Показать или сменить модель для этого чата" },
  { command: "think", description: "Показать или задать глубину рассуждений" },
  { command: "stop", description: "Остановить текущий ответ" },
  { command: "status", description: "Показать модель, сессию и текущий ответ" },
];

/**
 * myrmidon(X8c): `/start`, `/commands` and `/reset` are not part of the X8
 * contract's `TELEGRAM_DM_COMMANDS` (X8a canon), but OpenClaw's own DM
 * commands support them as compatibility aliases, so this bridge does too.
 */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  start: "help",
  commands: "help",
  reset: "new",
};

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
 * Longest command name echoed back in reply text (e.g. "Unknown command
 * /<name>."). `parsed.name` is untrusted chat input and BRIDGED_COMMAND_PATTERN
 * does not bound its length, so it is truncated before display. This is
 * separate from the `command` result field itself, which never carries
 * unvalidated chat input at all — see the two call sites below.
 */
const MAX_DISPLAYED_COMMAND_NAME_LENGTH = 64;

function truncateForDisplay(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
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
      return { kind: "reply", command: "close", text: "Этот чат не закрывается. Чтобы начать заново, отправьте /new." };
    case "task":
      return { kind: "reply", command: "task", text: "В личном чате просто напишите свой запрос." };
    default:
      // myrmidon(X8c): same reasoning as the not-available branch above —
      // `name` is unvalidated chat input here, so `command` gets a fixed
      // literal; the original name is shown in `text` only, and truncated,
      // since BRIDGED_COMMAND_PATTERN does not bound its length.
      return {
        kind: "reply",
        command: "unknown",
        text: `Неизвестная команда /${truncateForDisplay(parsed.name, MAX_DISPLAYED_COMMAND_NAME_LENGTH)}. Список команд — /help.`,
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
    return { kind: "message", body: "/new", notice: "Новая сессия начата. История остаётся на доске." };
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
    // A model chosen with /new applies to the fresh session it is about to
    // start regardless of what is currently running — same reasoning as
    // `checkTurnInProgress: false` above.
    refuseIfTurnInProgress: false,
  });
  const modelLabel =
    resolution.kind === "default"
      ? `по умолчанию у агента (${describeCardValue(context.agent.adapterConfig, MODEL_CHOOSER.adapterConfigKey)})`
      : resolution.candidate.id;
  return {
    kind: "message",
    body: "/new",
    notice: `Новая сессия начата с моделью ${modelLabel}. История остаётся на доске.`,
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
        text: chooser.unavailableText,
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
        `Доступно:\n${formatChatChoiceList(availability.candidates)}\n` +
        `Укажите /${chooser.commandName} <имя или номер> либо /${chooser.commandName} default.`,
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
    const overrideResult = await applyChatAdapterOverride({
      db: input.db,
      companyId: input.companyId,
      conversationAgentId: input.agentId,
      issueId: input.conversationIssueId,
      boardUserId: input.boardUserId,
      key: chooser.adapterConfigKey,
      value: null,
      // myrmidon(X8c): re-checked at write time (see overrides.ts) — a reply
      // can start in the gap between resolveChooserSelection's read above and
      // this write.
      refuseIfTurnInProgress: true,
    });
    if (!overrideResult.applied) {
      return { kind: "reply", command: chooser.commandName, text: TURN_IN_PROGRESS_TEXT };
    }
    return {
      kind: "reply",
      command: chooser.commandName,
      text: `${chooser.statusLabel} для этого чата: по умолчанию у агента (${describeCardValue(context.agent.adapterConfig, chooser.adapterConfigKey)}).`,
    };
  }

  const overrideResult = await applyChatAdapterOverride({
    db: input.db,
    companyId: input.companyId,
    conversationAgentId: input.agentId,
    issueId: input.conversationIssueId,
    boardUserId: input.boardUserId,
    key: chooser.adapterConfigKey,
    value: resolution.candidate.id,
    refuseIfTurnInProgress: true,
  });
  if (!overrideResult.applied) {
    return { kind: "reply", command: chooser.commandName, text: TURN_IN_PROGRESS_TEXT };
  }
  return {
    kind: "reply",
    command: chooser.commandName,
    text:
      `${chooser.statusLabel} для этого чата: ${resolution.candidate.id}. ` +
      "Следующий ответ начнёт новую сессию модели с недавней историей этого чата.",
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
    ? "Сейчас остановка недоступна."
    : result.stopped > 0
      ? "Останавливаю текущий ответ."
      : "Сейчас ничего не выполняется.";
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
