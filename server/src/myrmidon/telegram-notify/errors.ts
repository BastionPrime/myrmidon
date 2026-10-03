// server/src/myrmidon/telegram-notify/errors.ts
//
// myrmidon(1.6-TG-NOTIFY-C): the board errors channel.
//
// The owner can turn "board errors" into a message to a Telegram
// chat/topic. The error feed is computed on the fly from the attention
// desk (no new table, no migration): the closed error-kind set is
// `failed_run`, `agent_error_alert`, `budget_alert`. Each card passes a
// severity threshold (`minSeverity`) and a fixed per-hour rate limit
// (`maxPerHour` — over the limit, DROP, never a queue). Off by default:
// with the settings absent or disabled, nothing is read, filtered or sent.
//
// Settings come from the telegramNotify contract (part A of the
// umbrella task; the shared schema lives in
// packages/shared/src/myrmidon-telegram-notify.ts). Until part A's store
// and routes land, this module reads the `errors` area through the
// `ErrorChannelSettingsSource` port so its own tests never depend on part
// A's wiring, and part A can plug its store in with one adapter.
//
// Delivery reuses the existing chat publication path exactly the way the
// channel-task-close module does: ONE pending `chat_publications` row per
// attention card, keyed by an idempotency prefix, delivered by the
// vendor's publication sweep to the endpoint/conversation bound to the
// configured chat. No new Telegram client, no provider call from here.
//
// The rate limiter is in-memory (process state) by design: the task
// forbids a migration, a restart resets the hour bucket which re-admits
// messages — the safe direction for an alerting channel.

import { and, eq, sql } from "drizzle-orm";
import { chatConversations, chatPublications, type Db } from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";

/** The telegramNotify `errors` settings area this module consumes. */
export interface ErrorChannelSettings {
  enabled: boolean;
  chatId: string | null;
  topicId: string | null;
  minSeverity: "error" | "warning";
  maxPerHour: number;
}

/** Reading seam for the settings: part A's store in production, memory in tests. */
export interface ErrorChannelSettingsSource {
  read(companyId: string): Promise<ErrorChannelSettings>;
}

/** Reading seam for the attention feed: the vendor service in production. */
export interface AttentionFeedSource {
  list(companyId: string): Promise<AttentionItem[]>;
}

/**
 * The attention source kinds this channel treats as "board errors". A closed
 * list: a new attention kind never silently starts messaging the owner.
 */
export const ERROR_CHANNEL_SOURCE_KINDS = [
  "failed_run",
  "agent_error_alert",
  "budget_alert",
] as const;

export type ErrorChannelSourceKind = (typeof ERROR_CHANNEL_SOURCE_KINDS)[number];

/** Attention severity rank, highest first. */
const SEVERITY_RANK: Record<AttentionItem["severity"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * How `errors.minSeverity` maps onto attention severities:
 * `error` (the default) admits critical/high; `warning` also admits medium.
 * `low` is never admitted — the channel is for board errors, not chatter.
 */
const MIN_SEVERITY_RANK: Record<ErrorChannelSettings["minSeverity"], number> = {
  error: 3,
  warning: 2,
};

export type ErrorChannelFilterVerdict =
  | { send: false; reason: "disabled" | "no_chat" | "not_error_kind" | "below_threshold" }
  | { send: true };

/** Pure filter: settings → decision for one card. No I/O. */
export function filterErrorChannelCard(
  settings: ErrorChannelSettings,
  item: Pick<AttentionItem, "sourceKind" | "severity">,
): ErrorChannelFilterVerdict {
  if (!settings.enabled) return { send: false, reason: "disabled" };
  if (!settings.chatId) return { send: false, reason: "no_chat" };
  if (!(ERROR_CHANNEL_SOURCE_KINDS as readonly string[]).includes(item.sourceKind)) {
    return { send: false, reason: "not_error_kind" };
  }
  const rank = SEVERITY_RANK[item.severity] ?? 0;
  if (rank < (MIN_SEVERITY_RANK[settings.minSeverity] ?? MIN_SEVERITY_RANK.error)) {
    return { send: false, reason: "below_threshold" };
  }
  return { send: true };
}

/** Publication idempotency prefix: one row per attention card, ever. */
export const ERROR_CHANNEL_PUBLICATION_PREFIX = "notify:errors:";

export function errorChannelPublicationKey(input: Pick<AttentionItem, "companyId" | "dedupKey">): string {
  return `${ERROR_CHANNEL_PUBLICATION_PREFIX}${input.companyId}:${input.dedupKey}`;
}

/** Max characters of one card's message text that reach Telegram. */
export const ERROR_CHANNEL_TEXT_MAX = 600;

/**
 * The message text for one error card. Neutral English by construction:
 * title and whyNow come from the attention projection (already bounded);
 * this clamps the combined line again.
 */
export function errorChannelCardText(
  item: Pick<AttentionItem, "sourceKind" | "severity" | "subject" | "whyNow">,
): string {
  const title = item.subject.title ?? item.subject.id;
  const line = `[${item.severity}] ${title}: ${item.whyNow}`;
  return line.length > ERROR_CHANNEL_TEXT_MAX
    ? `${line.slice(0, ERROR_CHANNEL_TEXT_MAX - 1)}…`
    : line;
}

/**
 * Fixed sliding-hour rate limiter, `limit` admissions per hour bucket keyed
 * by company. Everything above the limit is dropped, never queued. In-memory
 * by design (no migration); a restart resets buckets, which re-admits — the
 * safe direction for alerts.
 */
export class HourlyRateLimiter {
  private readonly buckets = new Map<string, { hourStart: number; count: number }>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly windowMs: number = 60 * 60 * 1000,
  ) {}

  /** Count one admission attempt; true when the key is still under the limit. */
  admit(key: string, limit: number): boolean {
    if (limit <= 0) return false;
    const at = this.now().getTime();
    const hourStart = Math.floor(at / this.windowMs) * this.windowMs;
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.hourStart !== hourStart) {
      this.buckets.set(key, { hourStart, count: 1 });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  /** Test seam: forget all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/** Id of the conversation that receives error-channel messages, once resolved. */
export interface ErrorChannelTarget {
  endpointId: string;
  conversationId: string;
  issueId: string;
}

/**
 * Resolve the chat conversation for the configured chat target: an active
 * Telegram conversation of this company whose external conversation id
 * matches `chatId` (and thread id matches `topicId` when set). The
 * conversation must already exist — the owner picks a chat the bot is in,
 * which is exactly how the rest of the notify family addresses a chat.
 * Newest session generation wins, the same rule the close-notice helper
 * follows.
 */
export async function resolveErrorChannelTarget(
  db: Db,
  companyId: string,
  settings: Pick<ErrorChannelSettings, "chatId" | "topicId">,
): Promise<ErrorChannelTarget | null> {
  if (!settings.chatId) return null;
  const rows = await db
    .select({
      id: chatConversations.id,
      endpointId: chatConversations.endpointId,
      issueId: chatConversations.issueId,
      sessionGeneration: chatConversations.sessionGeneration,
      externalThreadId: chatConversations.externalThreadId,
    })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.companyId, companyId),
        eq(chatConversations.externalConversationId, settings.chatId),
        sql`${chatConversations.state} in ('active', 'waiting')`,
      ),
    )
    .orderBy(sql`${chatConversations.sessionGeneration} desc`)
    .limit(5);
  const matched =
    rows.find((row) => settings.topicId === null || row.externalThreadId === settings.topicId)
    ?? (settings.topicId === null ? rows[0] ?? null : null);
  if (!matched) return null;
  return {
    endpointId: matched.endpointId,
    conversationId: matched.id,
    issueId: matched.issueId,
  };
}

/**
 * Stage one error-card publication: a pending chat_publications row the
 * vendor's publication sweep delivers. onConflictDoNothing makes repeated
 * sweeps harmless — the same attention card is never re-sent.
 * Returns true when a new row was created.
 */
export async function stageErrorChannelPublication(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    issueId: string;
    idempotencyKey: string;
    text: string;
  },
): Promise<boolean> {
  const payload = projectSafeChatPublication({
    classification: "external",
    source: "safe_milestone",
    text: input.text,
  });
  const inserted = await db
    .insert(chatPublications)
    .values({
      companyId: input.companyId,
      endpointId: input.endpointId,
      conversationId: input.conversationId,
      issueId: input.issueId,
      idempotencyKey: input.idempotencyKey,
      payload,
      state: "pending",
    })
    .onConflictDoNothing({ target: [chatPublications.companyId, chatPublications.idempotencyKey] })
    .returning({ id: chatPublications.id });
  return inserted.length > 0;
}

export interface ErrorChannelSweepResult {
  /** Error-kind cards seen in the feed (after the kind filter). */
  checked: number;
  /** New publications staged this pass. */
  sent: number;
  /** Cards dropped by the rate limit (not queued anywhere). */
  droppedRateLimited: number;
  /** Cards skipped by threshold, or no resolvable target conversation. */
  skipped: number;
}

export interface ErrorChannelSweepDeps {
  db: Db;
  settings: ErrorChannelSettingsSource;
  feed: AttentionFeedSource;
  /** Insert seam for tests; production uses stageErrorChannelPublication. */
  stage?: typeof stageErrorChannelPublication;
  /** Rate limiter; production keeps one instance per process per company. */
  limiter?: HourlyRateLimiter;
}

/**
 * One pass over the attention feed of one company: filter error cards by
 * kind and severity, drop beyond `maxPerHour`, and stage one idempotent
 * publication per admitted card. Failures of the feed read propagate to the
 * caller (the scheduler logs them); a card already staged is a no-op.
 */
export async function sweepErrorChannel(
  companyId: string,
  deps: ErrorChannelSweepDeps,
): Promise<ErrorChannelSweepResult> {
  const settings = await deps.settings.read(companyId);
  const result: ErrorChannelSweepResult = { checked: 0, sent: 0, droppedRateLimited: 0, skipped: 0 };
  if (!settings.enabled || !settings.chatId) return result;

  const items = await deps.feed.list(companyId);
  const limiter = deps.limiter ?? new HourlyRateLimiter();
  const limit = Math.max(1, Math.trunc(settings.maxPerHour || 0)) || 1;
  const target = await resolveErrorChannelTarget(deps.db, companyId, settings);
  if (!target) return result;

  for (const item of items) {
    const cardVerdict = filterErrorChannelCard(settings, item);
    if (!cardVerdict.send) {
      if (cardVerdict.reason !== "disabled") result.skipped += 1;
      continue;
    }
    result.checked += 1;
    if (!limiter.admit(companyId, limit)) {
      result.droppedRateLimited += 1;
      continue;
    }
    const staged = await (deps.stage ?? stageErrorChannelPublication)(deps.db, {
      companyId,
      endpointId: target.endpointId,
      conversationId: target.conversationId,
      issueId: target.issueId,
      idempotencyKey: errorChannelPublicationKey(item),
      text: errorChannelCardText(item),
    });
    if (staged) result.sent += 1;
  }
  return result;
}
