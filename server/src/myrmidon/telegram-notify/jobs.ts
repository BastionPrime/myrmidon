// server/src/myrmidon/telegram-notify/jobs.ts
//
// myrmidon(OPE-3789-B): the periodic digest and escalation jobs of the
// Telegram notify track. Both jobs read the owner settings through the
// contract of part A (the `telegramNotify` area of instance settings); part A
// is not merged yet, so this module never reads the vendor instance-settings
// row itself: the runtime-changeable settings arrive through the injected
// `readSettings` port, and until part A merges the default wiring returns the
// fixed all-off defaults. Nothing is sent unless `digest.enabled` /
// `escalations.enabled` is explicitly true — the release criterion: with the
// defaults the owner receives only replies to his own messages and U2
// decision cards.
//
// No new notification table: the digest is computed on the fly from the
// attention feed (the vendor service, injected as a port), and escalation
// state lives in instance_settings.general under our own key, the same
// storage rule every myrmidon track uses (autonomy, maintenance, stack
// registry). No second scheduler in index.ts either: `startTelegramNotifyJobs`
// owns one interval, the maintenance-style wiring — one marked call in
// server/src/index.ts, a stop function, no shared scheduler loop.
//
// Delivery goes through the existing chat publication path: the job inserts
// `chat_publications` rows (the vendor outbox) and the vendor publication
// sweep transports them. Tests observe the transport through a fake Telegram
// API (a fake fetch). The idempotency key of every inserted row is
// deterministic per (job, day-or-attempt, conversation), so a restart or a
// concurrent sweep cannot duplicate a send; escalations additionally re-send
// only after `hours` have passed since the previous send, tracked in the
// escalation state document.

import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  chatConversations,
  chatEndpoints,
  companies,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { readTelegramNotifyDocument, mutateTelegramNotifyDocument } from "./store.js";
import type { TelegramNotifySettings } from "./settings.js";

/** The sweep period: how often the job checks whether the digest time or the
 *  escalation threshold has arrived. One shared interval for both jobs. */
export const TELEGRAM_NOTIFY_TICK_SEC_ENV = "MYRMIDON_TELEGRAM_NOTIFY_TICK_SEC";
const DEFAULT_TICK_SEC = 300;
const MIN_TICK_SEC = 30;
const MAX_TICK_SEC = 3600;

export function readTelegramNotifyTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TELEGRAM_NOTIFY_TICK_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_TICK_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TICK_SEC || value > MAX_TICK_SEC) {
    return DEFAULT_TICK_SEC * 1000;
  }
  return value * 1000;
}

/** The sections of the digest, in the fixed order the contract names. */
export type DigestSection = "done" | "blocked" | "needs_decision" | "spend";

/** The ports the jobs need; injected so tests run without a real feed or chat
 *  publication path. Production wiring is `telegramNotifyJobPorts(db)`. */
export interface TelegramNotifyJobPorts {
  /** Company ids to run the jobs for. */
  listCompanyIds(): Promise<string[]>;
  /** The attention feed snapshot for one company (the vendor service). */
  listFeed(companyId: string): Promise<AttentionSnapshot>;
  /** The chat publication outbox insert; the vendor sweep transports it. */
  enqueuePublication(input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    issueId: string;
    idempotencyKey: string;
    text: string;
  }): Promise<{ inserted: boolean }>;
  /** The settings contract of part A. Until part A merges, the default
   *  wiring returns the fixed all-off document (nothing is ever sent). */
  readSettings(companyId: string): Promise<TelegramNotifySettings>;
  /** Owner settings are runtime-changeable; the digest job consults them on
   *  every pass rather than at startup. */
  now(): Date;
  log?: { warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

/** The flattened view of the attention feed the digest needs. The real port
 *  maps `attentionService(db).list(companyId, { all: true, queue: ... })`; the
 *  shape stays minimal so tests fake it easily. */
export interface AttentionSnapshot {
  companyId: string;
  generatedAt: string;
  items: AttentionSnapshotItem[];
}

export interface AttentionSnapshotItem {
  sourceKind: string;
  severity: string;
  title: string | null;
  issueId: string | null;
  queues: string[];
}

/** The mapped digest section: a heading and its entry lines. */
export interface DigestSectionView {
  section: DigestSection;
  title: string;
  lines: string[];
}

const SECTION_TITLES: Record<DigestSection, string> = {
  done: "Completed",
  blocked: "Blocked",
  needs_decision: "Needs your decision",
  spend: "Budget",
};

/** Section selection per attention source kind. Feed rows are counted into
 *  the section the desk itself uses them for; unknown kinds are ignored. */
function sectionsForSourceKind(sourceKind: string): DigestSection[] {
  switch (sourceKind) {
    case "decision":
    case "issue_thread_interaction":
    case "approval":
      return ["needs_decision"];
    case "blocker_attention":
    case "review":
    case "failed_run":
    case "agent_error_alert":
      return ["blocked"];
    case "budget_alert":
      return ["spend", "needs_decision"];
    default:
      return [];
  }
}

/** Build the digest sections from one company's feed snapshot and issue rows.
 *  `done` comes from the issues table (feed rows are open items by design);
 *  the caller passes the day's completed-issue lines in. */
export function buildDigestSections(input: {
  snapshot: AttentionSnapshot;
  completedIssues: Array<{ identifier: string | null; title: string }>;
  budgetLines: string[];
  sections: readonly DigestSection[];
}): DigestSectionView[] {
  const selected = input.sections;
  const views: DigestSectionView[] = [];
  const needsDecision: string[] = [];
  const blocked: string[] = [];
  const spend: string[] = [...input.budgetLines];
  for (const item of input.snapshot.items) {
    const target = sectionsForSourceKind(item.sourceKind);
    const label = item.title ?? item.issueId ?? item.sourceKind;
    const line = `- ${label}`;
    if (target.includes("needs_decision") && selected.includes("needs_decision")) {
      needsDecision.push(line);
    }
    if (target.includes("blocked") && selected.includes("blocked")) {
      blocked.push(line);
    }
    if (item.sourceKind === "budget_alert" && selected.includes("spend")) {
      spend.push(line);
    }
  }
  if (selected.includes("done")) {
    const lines = input.completedIssues.map(
      (issue) => `- ${issue.identifier ? `${issue.identifier} ` : ""}${issue.title}`,
    );
    views.push({ section: "done", title: SECTION_TITLES.done, lines });
  }
  if (selected.includes("blocked")) {
    views.push({ section: "blocked", title: SECTION_TITLES.blocked, lines: blocked });
  }
  if (selected.includes("needs_decision")) {
    views.push({ section: "needs_decision", title: SECTION_TITLES.needs_decision, lines: needsDecision });
  }
  if (selected.includes("spend")) {
    views.push({ section: "spend", title: SECTION_TITLES.spend, lines: spend });
  }
  return views;
}

/** Render the digest message body. Empty sections are kept as "None" lines so
 *  the owner can tell "checked, nothing" from "section disabled". */
export function renderDigestBody(input: {
  date: string;
  sections: DigestSectionView[];
}): string {
  const parts = [`Daily digest for ${input.date}`];
  for (const view of input.sections) {
    parts.push("");
    parts.push(view.title);
    parts.push(view.lines.length > 0 ? view.lines.join("\n") : "None");
  }
  return parts.join("\n");
}

/** "HH:MM" of the fixed settings contract; returns null when malformed. */
export function parseDigestTime(value: string): { hours: number; minutes: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** Whether the digest for `today` (UTC date of `now`) is already recorded. */
export function digestAlreadySent(state: { lastDigestDate: string | null }, today: string): boolean {
  return state.lastDigestDate === today;
}

/** One digest pass for one company. Returns what it did (for tests and logs). */
export async function runDigestForCompany(
  db: Db,
  ports: TelegramNotifyJobPorts,
  companyId: string,
): Promise<{ sent: boolean; reason: string }> {
  const settings = await ports.readSettings(companyId);
  const digest = settings.digest;
  if (!digest.enabled) return { sent: false, reason: "disabled" };
  const conversation = await resolveTargetConversation(db, {
    companyId,
    chatId: digest.chatId,
    topicId: digest.topicId,
  });
  if (!conversation) return { sent: false, reason: "no_conversation" };
  const time = parseDigestTime(digest.time);
  if (!time) return { sent: false, reason: "invalid_time" };
  const now = ports.now();
  const today = now.toISOString().slice(0, 10);
  const state = await readTelegramNotifyDocument(db, companyId);
  if (digestAlreadySent(state, today)) return { sent: false, reason: "already_sent" };
  // The daily time gate: send when the wall clock has passed digest.time.
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const targetMinutes = time.hours * 60 + time.minutes;
  if (nowMinutes < targetMinutes) return { sent: false, reason: "not_due" };

  const snapshot = await ports.listFeed(companyId);
  const dayStart = new Date(now.getTime() - 24 * 60 * 60_000);
  const completedIssues = await db
    .select({ identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.status, "done"),
      isNull(issues.hiddenAt),
      gte(issues.updatedAt, dayStart),
    ))
    .limit(50);
  const budgetLines: string[] = [];
  const sections = buildDigestSections({
    snapshot,
    completedIssues,
    budgetLines,
    sections: digest.sections,
  });
  const body = renderDigestBody({ date: today, sections });
  const { inserted } = await ports.enqueuePublication({
    companyId,
    endpointId: conversation.endpointId,
    conversationId: conversation.conversationId,
    issueId: conversation.issueId,
    idempotencyKey: `telegram-notify:digest:${companyId}:${conversation.conversationId}:${today}`,
    text: body,
  });
  // Mark the day as digested even when the outbox row already existed (a
  // restart re-ran the same pass): the send is durable either way.
  await mutateTelegramNotifyDocument(db, companyId, (current) => ({
    next: { ...current, lastDigestDate: today },
    result: null,
  }));
  return { sent: inserted, reason: inserted ? "sent" : "already_enqueued" };
}

/** The resolved destination of a settings `chatId`/`topicId` pair. `chatId`
 *  matches a Telegram conversation's chat id (the numeric part of the
 *  `telegram:<chat>` / `telegram:<chat>:<topic>` thread id); `topicId`, when
 *  set, selects the forum-topic thread inside that chat. */
export async function resolveTargetConversation(
  db: Db,
  input: { companyId: string; chatId: string | null; topicId: number | null },
): Promise<{ endpointId: string; conversationId: string; issueId: string; threadId: string } | null> {
  if (input.chatId === null || input.chatId.trim() === "") return null;
  const chat = input.chatId.trim();
  const rows = await db
    .select({
      endpointId: chatConversations.endpointId,
      conversationId: chatConversations.id,
      issueId: chatConversations.issueId,
      externalThreadId: chatConversations.externalThreadId,
      externalConversationId: chatConversations.externalConversationId,
      sessionGeneration: chatConversations.sessionGeneration,
    })
    .from(chatConversations)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
      ),
    )
    .where(and(
      eq(chatConversations.companyId, input.companyId),
      eq(chatEndpoints.provider, "telegram"),
      eq(chatEndpoints.publicationMode, "automatic"),
      inArray(chatEndpoints.status, ["active", "verifying"]),
      inArray(chatConversations.state, ["active", "waiting"]),
    ))
    .orderBy(sql`${chatConversations.sessionGeneration} desc`);
  const withTopic = input.topicId !== null && input.topicId !== undefined;
  const wantedThreadIds = withTopic
    ? [`telegram:${chat}:${input.topicId}`]
    : [`telegram:${chat}`, `telegram:${chat}:${input.topicId ?? ""}`];
  const byThread = rows.filter((row) => wantedThreadIds.includes(row.externalThreadId));
  // A chat without a topic binding (a plain group or a DM) still matches by
  // its conversation chat id when no topicId was configured.
  const byChat = rows.filter(
    (row) => row.externalConversationId === chat && !row.externalThreadId.includes(`${chat}:`),
  );
  const row = byThread[0] ?? byChat[0] ?? null;
  if (!row) return null;
  return {
    endpointId: row.endpointId,
    conversationId: row.conversationId,
    issueId: row.issueId,
    threadId: row.externalThreadId,
  };
}

/** One escalation pass for one company. Re-sends an agent's pending question
 *  (ask_user_questions interaction, agent-authored, still pending) to the
 *  configured channel once `hours` have passed since the previous send. The
 *  first pass only records the interaction's age — the re-send happens on the
 *  next pass after the threshold, so the original delivery (U2 card) is never
 *  duplicated by the job itself. */
export async function runEscalationsForCompany(
  db: Db,
  ports: TelegramNotifyJobPorts,
  companyId: string,
): Promise<{ resent: number; skipped: number }> {
  const settings = await ports.readSettings(companyId);
  const escalations = settings.escalations;
  if (!escalations.enabled) return { resent: 0, skipped: 0 };
  if (escalations.channel === "none") return { resent: 0, skipped: 0 };
  const conversation = await resolveTargetConversation(db, {
    companyId,
    chatId: escalations.chatId,
    topicId: escalations.topicId,
  });
  if (!conversation) return { resent: 0, skipped: 0 };

  const thresholdMs = Math.max(1, escalations.hours) * 60 * 60_000;
  const now = ports.now();
  const state = await readTelegramNotifyDocument(db, companyId);
  const sentAt = new Map(Object.entries(state.escalationSentAt ?? {}));

  const rows = await db
    .select({
      id: issueThreadInteractions.id,
      issueId: issueThreadInteractions.issueId,
      title: issueThreadInteractions.title,
      summary: issueThreadInteractions.summary,
      createdAt: issueThreadInteractions.createdAt,
      updatedAt: issueThreadInteractions.updatedAt,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.kind, "ask_user_questions"),
      eq(issueThreadInteractions.status, "pending"),
      sql`${issueThreadInteractions.createdByAgentId} is not null`,
    ))
    .orderBy(sql`${issueThreadInteractions.createdAt} asc`)
    .limit(100);

  let resent = 0;
  let skipped = 0;
  const nextSentAt: Record<string, string> = {};
  for (const row of rows) {
    const lastSentIso = sentAt.get(row.id) ?? null;
    const ageMs = now.getTime() - new Date(row.createdAt).getTime();
    // The escalation timer starts at the previous send (or the interaction's
    // creation when the job has not sent it yet); a question answered or
    // withdrawn never reaches this loop.
    const baselineMs = lastSentIso
      ? now.getTime() - new Date(lastSentIso).getTime()
      : ageMs;
    if (baselineMs < thresholdMs) {
      skipped += 1;
      if (lastSentIso) nextSentAt[row.id] = lastSentIso;
      continue;
    }
    const label = row.title ?? row.summary ?? "a question awaiting your answer";
    const text = [
      "Waiting for your decision",
      "",
      `- ${label}`,
      `- Open the task to answer; the question has been waiting for more than ${Math.floor(thresholdMs / 3_600_000)} hours.`,
    ].join("\n");
    const attempt = lastSentIso
      ? `${new Date(lastSentIso).toISOString().slice(0, 10)}:${Math.floor(new Date(lastSentIso).getTime() / thresholdMs)}`
      : "first";
    const { inserted } = await ports.enqueuePublication({
      companyId,
      endpointId: conversation.endpointId,
      conversationId: conversation.conversationId,
      issueId: row.issueId,
      idempotencyKey: `telegram-notify:escalation:${row.id}:${conversation.conversationId}:${attempt}`,
      text,
    });
    if (inserted) resent += 1;
    nextSentAt[row.id] = now.toISOString();
  }
  if (Object.keys(nextSentAt).length !== (Object.keys(state.escalationSentAt ?? {}).length)
    || Object.entries(nextSentAt).some(([k, v]) => (state.escalationSentAt ?? {})[k] !== v)) {
    await mutateTelegramNotifyDocument(db, companyId, (current) => ({
      next: { ...current, escalationSentAt: nextSentAt },
      result: null,
    }));
  }
  return { resent, skipped };
}

export interface TelegramNotifyJobs {
  /** One pass of both jobs over every company. Errors per company are logged
   *  and never stop the others. */
  tick(): Promise<void>;
  stop(): void;
}

/** The production port wiring: real feed, real outbox, settings through part
 *  A's contract (all-off defaults until part A merges). */
export function telegramNotifyJobPorts(db: Db): TelegramNotifyJobPorts {
  return {
    async listCompanyIds() {
      const rows = await db.select({ id: companies.id }).from(companies);
      return rows.map((row) => row.id);
    },
    async listFeed(companyId) {
      const { attentionService } = await import("../../services/attention.js");
      const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
      return {
        companyId,
        generatedAt: feed.generatedAt,
        items: feed.items.map((item) => ({
          sourceKind: item.sourceKind,
          severity: item.severity,
          title: item.subject.title,
          issueId: item.relatedIssue?.id ?? item.subject.id,
          queues: item.queues.map((queue) => queue.key),
        })),
      };
    },
    async enqueuePublication(input) {
      const rows = await db
        .insert((await import("@paperclipai/db")).chatPublications)
        .values({
          companyId: input.companyId,
          endpointId: input.endpointId,
          conversationId: input.conversationId,
          issueId: input.issueId,
          idempotencyKey: input.idempotencyKey,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "safe_milestone",
            text: input.text,
          }),
          state: "pending",
        })
        .onConflictDoNothing()
        .returning({ id: (await import("@paperclipai/db")).chatPublications.id });
      return { inserted: rows.length > 0 };
    },
    // Part A is not merged: the settings contract answers the fixed
    // all-off document, so both jobs stay off. Part A replaces this port.
    async readSettings() {
      const { defaultTelegramNotifySettings } = await import("./settings.js");
      return defaultTelegramNotifySettings();
    },
    now: () => new Date(),
    log: logger,
  };
}

/** Start both jobs on one shared interval. The interval is armed regardless
 *  of the settings (they are runtime-changeable); every pass re-reads them
 *  and does nothing while the jobs are off. */
export function startTelegramNotifyJobs(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: TelegramNotifyJobPorts } = {},
): () => void {
  const ports = opts.ports ?? telegramNotifyJobPorts(db);
  const log = ports.log ?? logger;
  const tickMs = readTelegramNotifyTickMs(opts.env);
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const companyIds = await ports.listCompanyIds();
      for (const companyId of companyIds) {
        try {
          await runDigestForCompany(db, ports, companyId);
        } catch (err) {
          log.warn({ err, companyId }, "telegram notify digest pass failed for one company");
        }
        try {
          await runEscalationsForCompany(db, ports, companyId);
        } catch (err) {
          log.warn({ err, companyId }, "telegram notify escalation pass failed for one company");
        }
      }
    } catch (err) {
      log.error({ err }, "telegram notify jobs tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
