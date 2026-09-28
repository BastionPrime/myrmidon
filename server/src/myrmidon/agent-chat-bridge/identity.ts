/**
 * X8 conversation identity contract (agent-chat-bridge).
 *
 * A person can have two Agent Chat conversations with the same agent: the
 * vendor's web conversation, keyed by the board user id, and a Telegram
 * conversation, keyed by the same id with a "telegram:" prefix. Both share
 * one row shape (`issues` with `conversationAgentId` + `conversationUserId`
 * set) and the vendor's unique index on
 * `(companyId, conversationAgentId, conversationUserId)`, so the prefix is
 * what keeps the two rows distinct without a schema change.
 *
 * This module only knows about the key format. Nothing here reads or writes
 * the database; callers (X8b onward) do that.
 */

export const TELEGRAM_CONVERSATION_USER_PREFIX = "telegram:";

export type ConversationChannel = "web" | "telegram";

export type ConversationKey = {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
};

/**
 * Builds the Telegram conversation key for a board user id.
 * Throws on an empty id or an id that already carries the prefix (it would
 * otherwise silently double-encode and break `siblingConversationUserId`).
 */
export function telegramConversationUserId(boardUserId: string): string {
  if (!boardUserId) {
    throw new Error("telegramConversationUserId: boardUserId must not be empty");
  }
  if (boardUserId.startsWith(TELEGRAM_CONVERSATION_USER_PREFIX)) {
    throw new Error(
      "telegramConversationUserId: boardUserId is already a Telegram conversation id",
    );
  }
  return `${TELEGRAM_CONVERSATION_USER_PREFIX}${boardUserId}`;
}

/**
 * The board user id behind a Telegram conversation key, or null for any
 * other value (a web conversation's id, an empty string, `"telegram:"` with
 * nothing after it, null, undefined).
 */
export function parseTelegramConversationUserId(
  value: string | null | undefined,
): string | null {
  if (!value || !value.startsWith(TELEGRAM_CONVERSATION_USER_PREFIX)) return null;
  const boardUserId = value.slice(TELEGRAM_CONVERSATION_USER_PREFIX.length);
  return boardUserId.length > 0 ? boardUserId : null;
}

/**
 * "telegram" or "web" for an Agent Chat conversation (both identity fields
 * set, the same criterion the vendor's `isConversation` uses), otherwise
 * null for a plain task.
 */
export function conversationChannel(
  issue: ConversationKey | null | undefined,
): ConversationChannel | null {
  if (!issue?.conversationAgentId || !issue.conversationUserId) return null;
  return parseTelegramConversationUserId(issue.conversationUserId) !== null
    ? "telegram"
    : "web";
}

/**
 * The board user who owns the conversation in either channel; null for a
 * plain task (not a conversation at all).
 */
export function conversationOwnerUserId(
  issue: ConversationKey | null | undefined,
): string | null {
  if (!issue?.conversationAgentId || !issue.conversationUserId) return null;
  return parseTelegramConversationUserId(issue.conversationUserId) ?? issue.conversationUserId;
}

/**
 * The `conversationUserId` of the same person's conversation in the other
 * channel: web -> telegram and telegram -> web. Throws when the input is
 * itself not a valid conversation id on either side (empty, or a bare
 * `"telegram:"` prefix with no board user id after it).
 */
export function siblingConversationUserId(conversationUserId: string): string {
  const boardUserId = parseTelegramConversationUserId(conversationUserId);
  if (boardUserId !== null) return boardUserId;
  return telegramConversationUserId(conversationUserId);
}
