// server/src/myrmidon/cto-chat/telegram-entry.ts
//
// myrmidon(1.6-CTO-CHAT-B): the same planning step, entered from the owner's
// Telegram DM bridge.
//
// The owner's free text in the standing Telegram DM conversation (the X8b
// bridge) must reach the planner without a second planning implementation and
// without a second card type. So this module is a thin adapter: it takes an
// already-resolved bridge turn, runs the SAME planner, and posts the SAME
// `suggest_tasks` card on the task the conversation belongs to. Chat transport,
// identity and delivery stay where they already live.
//
// Delivery is deliberately out of scope here. The vendor's chat publication
// path externalizes questions and confirmations only — a `suggest_tasks` card is
// never projected into a chat provider by the board's own code, and inventing a
// second publication path for one card kind is exactly the kind of parallel
// machinery this feature is meant not to add. The card is therefore created on
// the standing conversation task, where the owner already reads that thread, and
// the caller reports the card back through the channel it owns:
//
//   - the bridge answers the owner's message with a short acknowledgement that
//     names the proposal and points at the task the card sits on;
//   - accepting it is the ordinary board acceptance path (the same endpoint the
//     portal card uses), so the tasks are created by the vendor's code.
//
// A caller that later wants an inline "accept" button in Telegram can add it to
// the bridge's own callback handling without touching this module: the module's
// contract is "plan, post the card, return a report", and the interaction id it
// returns is all a callback needs.

import type { Db } from "@paperclipai/db";

import type { CtoChatSource } from "@paperclipai/shared";

import {
  generateCtoChatPlan,
  type CtoChatPlanError,
  type CtoChatPlanResult,
} from "./plan-generator.js";
import type { CtoChatSettings } from "./settings.js";
import {
  createCtoChatPlanApproval,
  type CtoChatApprovalCard,
} from "./plan-approval.js";

/** A bridge turn that asks for a plan. Identity is resolved by the bridge already. */
export interface CtoChatTelegramTurn {
  companyId: string;
  /** The standing conversation task the owner's DM belongs to. */
  hostIssueId: string;
  /** The owner's message text. */
  text: string;
  /** The agent the card speaks as; the bridge resolving the DM knows it. */
  agentId: string | null;
  /** The run that is handling the turn, when there is one. */
  sourceRunId?: string | null;
}

export interface CtoChatTelegramEntryDeps {
  db: Db;
  settings: CtoChatSettings;
  fetch: typeof fetch;
  /** Mints the opaque plan id; injected so a test is deterministic. */
  mintPlanId(): string;
  /** Resolves the planner's API key for this company, or null when unavailable. */
  readCompanyKey(companyId: string): Promise<string | null>;
}

export type CtoChatTelegramOutcome =
  | { kind: "card"; plan: CtoChatPlanResult["plan"]; card: CtoChatApprovalCard }
  | { kind: "unavailable"; reason: string }
  | { kind: "rejected"; code: CtoChatPlanError["code"]; reason: string };

/** The source tag the planner records for a message that came from Telegram. */
export const CTO_CHAT_TELEGRAM_SOURCE: CtoChatSource = "telegram";

/**
 * Plan one Telegram message and post its approval card.
 *
 * The outcome never throws for a bad message or a model failure: a chat turn is
 * not a place to surface a stack trace, and the bridge must be able to tell the
 * owner something useful and keep the conversation alive. Configuration and
 * contract problems are reported as outcomes, not exceptions; an unexpected
 * database failure still throws, because the caller's framework should see it.
 */
export async function planFromTelegramTurn(
  turn: CtoChatTelegramTurn,
  deps: CtoChatTelegramEntryDeps,
): Promise<CtoChatTelegramOutcome> {
  if (!deps.settings.enabled) {
    return {
      kind: "unavailable",
      reason: "The board chat planner is not configured on this instance",
    };
  }
  const key = await deps.readCompanyKey(turn.companyId);
  if (!key) {
    return {
      kind: "unavailable",
      reason: "The planning model key is not available to this company",
    };
  }
  let planned: CtoChatPlanResult;
  try {
    planned = await generateCtoChatPlan(
      { text: turn.text, planId: deps.mintPlanId() },
      { fetch: deps.fetch, settings: deps.settings, apiKey: key },
    );
  } catch (error) {
    const code = (error as CtoChatPlanError).code;
    return {
      kind: "rejected",
      code,
      reason: error instanceof Error ? error.message : "The message could not be planned",
    };
  }
  const card = await createCtoChatPlanApproval(
    {
      plan: planned.plan,
      hostIssueId: turn.hostIssueId,
      companyId: turn.companyId,
      createdByAgentId: turn.agentId,
      sourceRunId: turn.sourceRunId ?? null,
      summary: cardSummary(planned.plan.tasks.length),
    },
    { db: deps.db },
  );
  return { kind: "card", plan: planned.plan, card };
}

/** The one-line summary the card carries; the owner's own text is not echoed. */
export function cardSummary(childCount: number): string {
  return childCount === 1
    ? "Proposed from your message: one epic with one task."
    : `Proposed from your message: one epic with ${childCount} tasks.`;
}

/**
 * The short reply a bridge sends back for an outcome. Kept here so the portal
 * and the Telegram entry word the same result the same way, and so a bridge
 * adapter has nothing to invent. The task the card lives on is a link target the
 * caller supplies, not something this module can know.
 */
export function describeTelegramOutcome(outcome: CtoChatTelegramOutcome, taskUrl: string | null): string {
  if (outcome.kind === "card") {
    const lines = [
      `Proposed epic: ${outcome.plan.epic.title}`,
      `${outcome.plan.tasks.length} task(s) proposed for your approval.`,
    ];
    lines.push(
      taskUrl
        ? `Review and accept it on the task: ${taskUrl}`
        : "Review and accept it on the task in the board.",
    );
    return lines.join("\n");
  }
  if (outcome.kind === "unavailable") return `I cannot plan right now: ${outcome.reason}.`;
  return `I could not turn that into a plan: ${outcome.reason}.`;
}