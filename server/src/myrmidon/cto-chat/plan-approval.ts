// server/src/myrmidon/cto-chat/plan-approval.ts
//
// myrmidon(1.6-CTO-CHAT-B): a proposal becomes a card the owner can accept, and
// accepting the card is what creates the tasks.
//
// No new card type. The board already has exactly the card this needs —
// `suggest_tasks`: a pending interaction carrying a list of task drafts, with
// the vendor's acceptance path creating one issue per draft, parenting a child
// on the draft it names, and assigning nobody unless the draft says so. This
// module only turns a proposal into such a card and hands it to the vendor's
// service. Rejection, expiry, supersede and the creation transaction all stay
// the vendor's code.
//
// Where the card lives. A card is attached to a task, so the host task is the
// owner's standing chat task (the Agent Chat conversation issue) that the chat
// screen and the Telegram bridge already share — the same place the plan was
// requested from. That way the card sits in the thread the owner is reading, and
// the vendor's own wake on a resolution reaches whoever is on that task.
//
// The card names no assignee: who does the work is a staffing decision the lead
// makes, not something the planner may infer from prose (see the epic note).

import type { Db } from "@paperclipai/db";

import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import type { CtoChatPlan } from "@paperclipai/shared";

import { toSuggestTasksPayload } from "@paperclipai/shared";

/** A card that could not be created, with the vendor's own message. */
export class CtoChatApprovalError extends Error {
  readonly code: "card_not_created";
  constructor(message: string) {
    super(message);
    this.name = "CtoChatApprovalError";
    this.code = "card_not_created";
  }
}

export interface CtoChatApprovalDeps {
  db: Db;
}

/** The card as the caller needs to report it back to the owner. */
export interface CtoChatApprovalCard {
  interactionId: string;
  /** The task the card hangs on. */
  hostIssueId: string;
  status: string;
  createdByAgentId: string | null;
}

/**
 * The idempotency key of a proposal's card. The plan id is minted by the
 * planner and unique per request, so a retried request that re-plans gets a
 * fresh plan id and a fresh card; a retried CALL with the same plan id returns
 * the card that already exists instead of stacking a second one.
 */
export function ctoChatApprovalIdempotencyKey(planId: string): string {
  return `cto-chat-plan:${planId}`;
}

/**
 * Build the pending `suggest_tasks` card for a proposal on the given host task.
 *
 * `createdByAgentId` is the agent the card speaks as: the vendor refuses to
 * externalize a card with no creator, and uses that id to decide which chat
 * endpoint may carry it. `sourceRunId` links the card to the run that planned
 * it, which is what the vendor's continuation wake needs.
 */
export async function createCtoChatPlanApproval(
  input: {
    plan: CtoChatPlan;
    hostIssueId: string;
    companyId: string;
    createdByAgentId: string | null;
    sourceRunId?: string | null;
    /** Shown at the top of the card; the owner's original message is not echoed. */
    summary?: string | null;
  },
  deps: CtoChatApprovalDeps,
): Promise<CtoChatApprovalCard> {
  const payload = toSuggestTasksPayload(input.plan);
  const service = issueThreadInteractionService(deps.db);
  let interaction;
  try {
    interaction = await service.create(
      { id: input.hostIssueId, companyId: input.companyId },
      {
        kind: "suggest_tasks",
        idempotencyKey: ctoChatApprovalIdempotencyKey(input.plan.planId),
        title: `Proposed epic: ${input.plan.epic.title}`,
        summary: input.summary ?? null,
        // Accepting the card should resume whoever owns the chat task, so the
        // owner sees the outcome in the thread they answered in.
        continuationPolicy: "wake_assignee",
        sourceRunId: input.sourceRunId ?? null,
        payload: {
          version: 1,
          tasks: payload.tasks.map((task) => ({
            clientKey: task.clientKey,
            parentClientKey: task.parentClientKey,
            title: task.title,
            description: task.description,
            priority: task.priority,
          })),
        },
      },
      { agentId: input.createdByAgentId },
    );
  } catch (error) {
    throw new CtoChatApprovalError(
      error instanceof Error ? error.message : "The approval card could not be created",
    );
  }
  return {
    interactionId: interaction.id,
    hostIssueId: input.hostIssueId,
    status: interaction.status,
    createdByAgentId: interaction.createdByAgentId ?? null,
  };
}