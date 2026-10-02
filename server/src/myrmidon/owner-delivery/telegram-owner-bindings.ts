// myrmidon(U2): deliver an agent's question/confirmation card to the owner's
// standing Telegram DM conversation (the X8b bridge) when the task the card
// belongs to has no chat-thread binding of its own. Everything the vendor
// already enqueues stays untouched; this only adds bindings the vendor cannot
// know about. See docs/myrmidon/DIVERGENCE.md, track 4 (U2).
import { and, eq, inArray } from "drizzle-orm";
import { chatConversations, chatEndpoints, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { telegramConversationUserId } from "../agent-chat-bridge/identity.js";

/** Bindings the owner-delivery extension may hand back to the publication path. */
export interface OwnerDeliveryBinding {
  conversation: typeof chatConversations.$inferSelect;
  endpoint: typeof chatEndpoints.$inferSelect;
}

type OwnerDeliveryDb = Pick<Db, "select">;

/**
 * myrmidon(U2): find the standing Telegram DM conversation (X8b) between the
 * card's authoring agent and the task's owner, for Telegram endpoints whose
 * bot is that same agent. The rules mirror the vendor's own binding rules so a
 * card never speaks through another agent's endpoint:
 *
 * - the endpoint is Telegram, automatic publication mode, active/verifying;
 * - the endpoint's immutable assigned agent is the card's creator;
 * - the conversation is a live (active/waiting) DM standing conversation of
 *   the task's owner with that agent (`telegram:<boardUserId>` identity).
 *
 * Returns [] when nothing matches, so the caller degrades to vendor behavior.
 */
export async function telegramOwnerDeliveryBindings(
  db: OwnerDeliveryDb,
  input: {
    companyId: string;
    issueId: string;
    createdByAgentId: string | null | undefined;
  },
): Promise<OwnerDeliveryBinding[]> {
  if (!input.createdByAgentId) return [];
  const createdByAgentId = input.createdByAgentId;
  const [issueRow] = await db
    .select({
      responsibleUserId: issues.responsibleUserId,
      createdByUserId: issues.createdByUserId,
      conversationAgentId: issues.conversationAgentId,
      conversationUserId: issues.conversationUserId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.issueId),
      ),
    )
    .then((rows) => (rows.length > 0 ? rows : []));
  const issue = issueRow ?? null;
  if (!issue) return [];
  // A task that already lives as an Agent Chat conversation (web or Telegram)
  // has its own routing; never mirror its cards into another conversation.
  if (issue.conversationAgentId && issue.conversationUserId) return [];

  // The owner receiving the card: the responsible user when the task names
  // one, otherwise its creator. A board user id, not an external identity.
  const ownerUserId =
    issue.responsibleUserId ?? issue.createdByUserId ?? null;
  if (!ownerUserId) return [];

  const rows = await db
    .select({
      conversation: chatConversations,
      endpoint: chatEndpoints,
      conversationIssue: issues,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, chatConversations.companyId),
        eq(issues.id, chatConversations.issueId),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, input.companyId),
        eq(
          issues.conversationUserId,
          telegramConversationUserId(ownerUserId),
        ),
        eq(issues.conversationAgentId, createdByAgentId),
        inArray(chatConversations.state, ["active", "waiting"]),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  return rows.filter(
    ({ conversation, endpoint }) =>
      endpoint.provider === "telegram" &&
      endpoint.publicationMode === "automatic" &&
      endpoint.assignedAgentId === createdByAgentId &&
      conversation.isDirectMessage === true,
  );
}
