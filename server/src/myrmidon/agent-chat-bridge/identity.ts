/**
 * myrmidon(X8): a Telegram direct message with a bridged bot becomes a
 * standing Agent Chat conversation, the same way a web Agent Chat does, but
 * keyed by a synthetic `telegram:<board user id>` value so the two channels
 * never collide on the `(company, agent, conversationUserId)` slot that Agent
 * Chat already enforces as unique.
 *
 * This file is the X8 contract as specified for the whole X8 feature: X8a is
 * its canonical home. This PR (X8c, commands) ships its own copy so it
 * compiles and its tests stand on their own before X8a merges. Whichever of
 * X8a/X8b/X8c/X8d lands second drops this duplicate in favor of X8a's file;
 * the exported names and behavior are meant to match exactly.
 */

/** Prefix that marks a `conversationUserId` as a Telegram, not a web, conversation. */
export const TELEGRAM_CONVERSATION_USER_PREFIX = "telegram:";

export type ConversationChannel = "web" | "telegram";

export type ConversationKey = {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
};

/**
 * The `conversationUserId` for this board user's Telegram conversation with
 * an agent. Throws if `boardUserId` is already a Telegram conversation id
 * (real board user ids never carry this prefix).
 */
export function telegramConversationUserId(boardUserId: string): string {
  if (boardUserId.startsWith(TELEGRAM_CONVERSATION_USER_PREFIX)) {
    throw new Error(
      `board user id already looks like a Telegram conversation id: ${boardUserId}`,
    );
  }
  return `${TELEGRAM_CONVERSATION_USER_PREFIX}${boardUserId}`;
}

/** The board user id wrapped in a Telegram `conversationUserId`, or null if it isn't one. */
export function parseTelegramConversationUserId(
  value: string | null | undefined,
): string | null {
  if (!value || !value.startsWith(TELEGRAM_CONVERSATION_USER_PREFIX)) return null;
  const boardUserId = value.slice(TELEGRAM_CONVERSATION_USER_PREFIX.length);
  return boardUserId.length > 0 ? boardUserId : null;
}

/** Which channel this conversation belongs to, or null when it is not a conversation at all. */
export function conversationChannel(
  issue: ConversationKey | null | undefined,
): ConversationChannel | null {
  if (!issue?.conversationAgentId || !issue.conversationUserId) return null;
  return parseTelegramConversationUserId(issue.conversationUserId) !== null
    ? "telegram"
    : "web";
}

/** The board user this conversation belongs to, regardless of which channel it is on. */
export function conversationOwnerUserId(
  issue: ConversationKey | null | undefined,
): string | null {
  if (!issue?.conversationUserId) return null;
  return (
    parseTelegramConversationUserId(issue.conversationUserId) ??
    issue.conversationUserId
  );
}

/**
 * The `conversationUserId` of the same person's conversation with this agent
 * on the other channel (web <-> Telegram).
 */
export function siblingConversationUserId(conversationUserId: string): string {
  const boardUserId = parseTelegramConversationUserId(conversationUserId);
  return boardUserId !== null
    ? boardUserId
    : telegramConversationUserId(conversationUserId);
}
