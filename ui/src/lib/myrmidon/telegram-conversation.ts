import type { Issue } from "@paperclipai/shared";

/**
 * myrmidon(X8f): Contract from X8a. A Telegram direct-message conversation
 * reuses the Agent Chat conversation key (`conversationAgentId` +
 * `conversationUserId`), with `conversationUserId` prefixed by
 * `"telegram:"` followed by the board user id. Real board user ids never
 * carry this prefix, so the check is unambiguous.
 *
 * The server module that owns this contract lives outside `ui/` and cannot
 * be imported here, so the prefix is duplicated as a constant (per X8a).
 */
export const TELEGRAM_CONVERSATION_USER_PREFIX = "telegram:";

/**
 * myrmidon(X8f): True when this issue is the standing Agent Chat
 * conversation for someone's Telegram direct messages with an agent, as
 * opposed to their web conversation with the same agent (or a plain,
 * non-conversation issue).
 *
 * Mirrors X8a's `parseTelegramConversationUserId`: the prefix alone is not
 * enough, there must be a non-empty board user id after it.
 */
export function isTelegramConversationIssue(
  issue: Pick<Issue, "conversationAgentId" | "conversationUserId"> | null | undefined,
): boolean {
  if (!issue?.conversationAgentId || !issue.conversationUserId) {
    return false;
  }
  const userId = issue.conversationUserId;
  return (
    userId.startsWith(TELEGRAM_CONVERSATION_USER_PREFIX) &&
    userId.length > TELEGRAM_CONVERSATION_USER_PREFIX.length
  );
}
