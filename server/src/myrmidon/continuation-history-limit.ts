import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/**
 * Bounded continuation history (P3).
 *
 * buildExecutionContinuation() returns the whole task history. On long tasks the
 * rendered wake prompt outgrows the per-argument limit of the OS and the agent
 * process fails to start (spawn E2BIG). This module caps every unbounded list of
 * the envelope to the newest N entries. Ownership, integrity and authorization
 * checks keep running against the full history upstream; only the returned
 * envelope is trimmed.
 *
 * Messages that carry direction are always kept, even when older than the newest
 * N: the original request of the task, the latest request, and the comments the
 * run was woken for (originCommentIds).
 */

export const CONTINUATION_HISTORY_LIMIT_ENV = "MYRMIDON_CONTINUATION_HISTORY_LIMIT";
export const DEFAULT_CONTINUATION_HISTORY_LIMIT = 30;

type Message = ExecutionContinuationEnvelope["messages"][number];

export interface ContinuationListTruncation {
  kept: number;
  dropped: number;
  total: number;
}

export type ContinuationHistoryTruncation = Partial<
  Record<
    | "messages"
    | "resumeDeltaMessages"
    | "interactionOutcomes"
    | "completedActions"
    | "recoveryOutcomes"
    | "unresolvedInteractionIds",
    ContinuationListTruncation
  >
>;

export type LimitedExecutionContinuationEnvelope = ExecutionContinuationEnvelope & {
  historyTruncation?: ContinuationHistoryTruncation;
  truncationNotice?: string;
};

/** Returns the configured limit; 0 disables the limit. Invalid values fall back to the default. */
export function readContinuationHistoryLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CONTINUATION_HISTORY_LIMIT_ENV]?.trim();
  if (!raw) return DEFAULT_CONTINUATION_HISTORY_LIMIT;
  if (!/^\d+$/.test(raw)) return DEFAULT_CONTINUATION_HISTORY_LIMIT;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_CONTINUATION_HISTORY_LIMIT;
}

function isUserRequest(message: Message): boolean {
  return (
    message.authorType === "user" &&
    !message.createdByRunId &&
    !message.deleted &&
    message.body.trim().length > 0
  );
}

/** Ids of the messages that must survive truncation, computed on the full history. */
function pinnedMessageIds(messages: Message[], originCommentIds: string[]): Set<string> {
  const pinned = new Set<string>(originCommentIds);
  const first = messages.find(isUserRequest);
  const latest = messages.findLast(isUserRequest);
  if (first) pinned.add(first.id);
  if (latest) pinned.add(latest.id);
  return pinned;
}

/** Keeps pinned messages plus the newest ones, up to `limit` in total when the pins allow it. */
function limitMessages(
  messages: Message[],
  pinned: Set<string>,
  limit: number,
): { items: Message[]; truncation: ContinuationListTruncation | null } {
  if (messages.length <= limit) return { items: messages, truncation: null };
  const keep = new Set<string>();
  for (const message of messages) if (pinned.has(message.id)) keep.add(message.id);
  for (let i = messages.length - 1; i >= 0 && keep.size < limit; i -= 1) keep.add(messages[i]!.id);
  const items = messages.filter((message) => keep.has(message.id));
  return {
    items,
    truncation: { kept: items.length, dropped: messages.length - items.length, total: messages.length },
  };
}

/** Keeps the newest `limit` entries of a list sorted oldest first. */
function limitList<T>(
  list: T[] | undefined,
  limit: number,
): { items: T[] | undefined; truncation: ContinuationListTruncation | null } {
  if (!list || list.length <= limit) return { items: list, truncation: null };
  const items = list.slice(-limit);
  return { items, truncation: { kept: items.length, dropped: list.length - items.length, total: list.length } };
}

export function limitExecutionContinuationHistory(
  envelope: ExecutionContinuationEnvelope,
  limit: number = readContinuationHistoryLimit(),
): LimitedExecutionContinuationEnvelope {
  if (limit <= 0) return envelope;

  const pinned = pinnedMessageIds(envelope.messages, envelope.originCommentIds);
  const messages = limitMessages(envelope.messages, pinned, limit);
  const resumeDeltaMessages = envelope.resumeDelta
    ? limitMessages(envelope.resumeDelta.messages, pinned, limit)
    : null;
  const interactionOutcomes = limitList(envelope.interactionOutcomes, limit);
  const completedActions = limitList(envelope.completedActions, limit);
  const recoveryOutcomes = limitList(envelope.recoveryOutcomes, limit);
  const unresolvedInteractionIds = limitList(envelope.unresolvedInteractionIds, limit);

  const truncation: ContinuationHistoryTruncation = {};
  if (messages.truncation) truncation.messages = messages.truncation;
  if (resumeDeltaMessages?.truncation) truncation.resumeDeltaMessages = resumeDeltaMessages.truncation;
  if (interactionOutcomes.truncation) truncation.interactionOutcomes = interactionOutcomes.truncation;
  if (completedActions.truncation) truncation.completedActions = completedActions.truncation;
  if (recoveryOutcomes.truncation) truncation.recoveryOutcomes = recoveryOutcomes.truncation;
  if (unresolvedInteractionIds.truncation) {
    truncation.unresolvedInteractionIds = unresolvedInteractionIds.truncation;
  }
  const entries = Object.entries(truncation) as Array<[string, ContinuationListTruncation]>;
  if (entries.length === 0) return envelope;

  const result: LimitedExecutionContinuationEnvelope = {
    ...envelope,
    messages: messages.items,
    interactionOutcomes: interactionOutcomes.items ?? [],
    unresolvedInteractionIds: unresolvedInteractionIds.items ?? [],
    historyTruncation: truncation,
    truncationNotice:
      `Task history was shortened to the newest ${limit} entries per list to keep the launch ` +
      "payload within process limits. The original request, the latest request and the " +
      "comments that triggered this run are always included. Omitted entries: " +
      entries.map(([name, value]) => `${name} ${value.dropped} of ${value.total}`).join(", ") +
      ". Read the task thread through the API if you need the older entries.",
  };
  if (envelope.resumeDelta && resumeDeltaMessages) {
    result.resumeDelta = { ...envelope.resumeDelta, messages: resumeDeltaMessages.items };
  }
  if (completedActions.items) result.completedActions = completedActions.items;
  if (recoveryOutcomes.items) result.recoveryOutcomes = recoveryOutcomes.items;
  return result;
}
