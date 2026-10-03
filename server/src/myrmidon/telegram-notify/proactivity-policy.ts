// myrmidon(1.6-TG-PROACTIVITY-E): head-bot proactivity policy — the gate.
//
// Part E of the TG-NOTIFY-SETTINGS epic (1.6.1), point 5: a per-agent
// proactivity policy with three modes:
//
//   only_on_owner_request (default) — the head bot sends nothing on its own
//     initiative: outbound chat publications authored by the bot are blocked
//     unless they are a reply to an owner message or a U2 decision card;
//   rarely — at most `rarelyMaxPerDay` proactive messages per agent per day,
//     the rest is bundled into one daily summary publication;
//   normal — no limit.
//
// What counts as "proactive": an outbound chat publication the owner did not
// ask for. Replies to an owner's inbound message (the run was woken by the
// conversation's own inbound link) and the U2 owner decision cards (the
// vendor's own interaction publications) are owner-driven and always pass.
// Everything else the head bot would publish on its own (its own explicit
// external comments on tasks the owner never messaged about, run milestone
// noise beyond the DM status lane) is gated here.
//
// Storage: the mode document lives under instance settings area
// `telegramNotify` (the fixed part-A contract; read through a provider seam
// so this module compiles and tests run before part A merges — production
// wires the real reader, tests use an in-memory one). The per-agent override
// is agent metadata key `mode`. The rarely day counter lives in the same
// instance-settings JSON document under our own key — no migration.
//
// This module owns only the decision. It never talks to a provider.

import { eq, sql } from "drizzle-orm";
import { agents, instanceSettings, type Db } from "@paperclipai/db";
import {
  DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
  DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY,
  MAX_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_PER_DAY,
  TELEGRAM_NOTIFY_PROACTIVITY_AGENT_METADATA_KEY,
  defaultTelegramNotifySettings,
  resolveProactivityMode,
  telegramNotifySettingsSchema,
  type TelegramNotifyProactivityMode,
} from "@paperclipai/shared";

/** Our own key inside instance_settings.general: the rarely day counters. */
export const TELEGRAM_NOTIFY_GENERAL_KEY = "myrmidonTelegramNotify";

const SINGLETON_KEY = "default";

/** How many proactive texts one conversation's bundle queue keeps. */
export const MAX_BUNDLED_PROACTIVITY_TEXTS = 50;

/** A UTC day bucket ("YYYY-MM-DD"): the rarely limit resets on the boundary. */
export function telegramNotifyDayBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The persisted state we keep ourselves: the rarely day counters and the
 * queue of proactive texts the rarely limit bundled instead of sending.
 * Shape:
 *   {
 *     version: 1,
 *     day: "YYYY-MM-DD",
 *     sentByAgent: { [agentId]: number },
 *     bundledByConversation: { [conversationId]: {
 *       companyId, endpointId, issueId, texts: string[], lastAt } }
 *   }
 * A row from another day is read as an empty counter (the day boundary reset).
 */
export interface BundledProactivityQueue {
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string | null;
  texts: string[];
  lastAt: string;
}

export interface TelegramNotifyCountersDocument {
  version: 1;
  day: string;
  sentByAgent: Record<string, number>;
  bundledByConversation: Record<string, BundledProactivityQueue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBundledQueue(raw: unknown): BundledProactivityQueue | null {
  if (!isRecord(raw)) return null;
  const companyId = typeof raw.companyId === "string" ? raw.companyId : "";
  const endpointId = typeof raw.endpointId === "string" ? raw.endpointId : "";
  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : "";
  const issueId = typeof raw.issueId === "string" ? raw.issueId : null;
  const lastAt = typeof raw.lastAt === "string" ? raw.lastAt : "";
  if (!companyId || !endpointId || !conversationId || !lastAt) return null;
  const texts = Array.isArray(raw.texts)
    ? raw.texts.filter((text): text is string => typeof text === "string").slice(0, MAX_BUNDLED_PROACTIVITY_TEXTS)
    : [];
  return { companyId, endpointId, conversationId, issueId, texts, lastAt };
}

export function parseTelegramNotifyCounters(raw: unknown): TelegramNotifyCountersDocument {
  if (!isRecord(raw)) return { version: 1, day: "", sentByAgent: {}, bundledByConversation: {} };
  const day = typeof raw.day === "string" ? raw.day : "";
  const sentByAgent: Record<string, number> = {};
  if (isRecord(raw.sentByAgent)) {
    for (const [agentId, value] of Object.entries(raw.sentByAgent)) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        sentByAgent[agentId] = value;
      }
    }
  }
  const bundledByConversation: Record<string, BundledProactivityQueue> = {};
  if (isRecord(raw.bundledByConversation)) {
    for (const [conversationId, value] of Object.entries(raw.bundledByConversation)) {
      const queue = parseBundledQueue(value);
      if (queue) bundledByConversation[conversationId] = queue;
    }
  }
  return { version: 1, day, sentByAgent, bundledByConversation };
}

/** Keep our key across vendor writes of instance_settings.general. */
export function preserveTelegramNotifyGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[
    TELEGRAM_NOTIFY_GENERAL_KEY
  ];
  return value === undefined ? {} : { [TELEGRAM_NOTIFY_GENERAL_KEY]: value };
}

/**
 * The settings reader seam: production reads the part-A `telegramNotify`
 * settings area; until that area is merged (and in tests) a caller supplies
 * the document directly. `null` means "no settings yet" — the defaults apply.
 */
export type TelegramNotifySettingsReader = () => Promise<{
  proactivity: { mode: TelegramNotifyProactivityMode; rarelyMaxPerDay: number };
} | null>;

/** Read the settings document from instance settings `experimental`. */
export function experimentalTelegramNotifySettingsReader(
  db: Pick<Db, "select">,
): TelegramNotifySettingsReader {
  return async () => {
    const row = await db
      .select({ experimental: instanceSettings.experimental })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const stored = isRecord(row.experimental)
      ? (row.experimental as Record<string, unknown>)["telegramNotify"]
      : undefined;
    if (!isRecord(stored)) return null;
    const defaults = defaultTelegramNotifySettings();
    const parsed = telegramNotifySettingsSchema.safeParse({
      ...defaults,
      ...stored,
      proactivity: { ...defaults.proactivity, ...(isRecord(stored.proactivity) ? stored.proactivity : {}) },
    });
    if (!parsed.success) return null;
    return { proactivity: parsed.data.proactivity };
  };
}

/** Clamp the rarely ceiling the same way the shared validator does. */
export function clampRarelyMaxPerDay(
  value: number | undefined,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY;
  }
  return Math.min(value, MAX_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_PER_DAY);
}

/** The verdict of the gate for one candidate proactive publication. */
export type ProactivityGateVerdict =
  | { outcome: "allow" }
  | { outcome: "block" }
  | { outcome: "bundle" };

export interface ProactivityGateInput {
  /** The agent whose endpoint would publish (endpoint.assignedAgentId). */
  agentId: string | null | undefined;
  /**
   * The publication's idempotency key. Owner-driven lanes are recognized by
   * their key prefixes: `interaction:` (the U2 owner decision cards),
   * `run:*:dmstatus:` (the one editable DM status row per run) and `control:`
   * (direct command answers). Everything else is proactive.
   */
  idempotencyKey: string;
  /**
   * True when the publication is a reply to an inbound owner message — the
   * vendor's own binding resolution already proves this causally (the run's
   * chat wake lineage); the caller passes the proof, not the guess.
   */
  isReplyToOwner: boolean;
}

const OWNER_DRIVEN_KEY = /^(?:interaction:|run:[^:]+:dmstatus:|control:|explicit:|explicit-board:|wake:)/;

export function isOwnerDrivenPublicationKey(idempotencyKey: string): boolean {
  return OWNER_DRIVEN_KEY.test(idempotencyKey);
}

/**
 * The pure decision core: given the effective mode, today's already-sent
 * count and the ceiling, what happens to one candidate publication.
 * The caller owns reading the mode and persisting the counter.
 */
export function decideProactivity(input: {
  mode: TelegramNotifyProactivityMode;
  sentToday: number;
  rarelyMaxPerDay: number;
  candidate: ProactivityGateInput;
}): ProactivityGateVerdict {
  const ownerDriven =
    input.candidate.isReplyToOwner ||
    isOwnerDrivenPublicationKey(input.candidate.idempotencyKey);
  if (ownerDriven) return { outcome: "allow" };
  switch (input.mode) {
    case "only_on_owner_request":
      return { outcome: "block" };
    case "normal":
      return { outcome: "allow" };
    case "rarely":
      if (input.candidate.agentId && input.sentToday < input.rarelyMaxPerDay) {
        return { outcome: "allow" };
      }
      return { outcome: "bundle" };
  }
}

/**
 * The durable gate: resolves the effective per-agent mode (agent metadata
 * override over the company default), applies the pure decision, and for an
 * allowed `rarely` send increments the day counter in one read-modify-write
 * under the row lock (the same pattern the autonomy store uses). Returns the
 * verdict; the caller cancels or bundles on `block`/`bundle`.
 */
export async function applyProactivityGate(
  db: Db,
  settings: TelegramNotifySettingsReader,
  candidate: ProactivityGateInput,
  options: { now?: () => Date } = {},
): Promise<ProactivityGateVerdict> {
  const now = options.now ?? (() => new Date());
  const document = (await settings()) ?? null;
  const proactivity = document?.proactivity ?? {
    mode: DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
    rarelyMaxPerDay: DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY,
  };
  const agentMetadata = candidate.agentId
    ? await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, candidate.agentId))
        .limit(1)
        .then((rows) => rows[0]?.metadata ?? null)
    : null;
  const mode = resolveProactivityMode(proactivity, agentMetadata);
  const rarelyMaxPerDay = clampRarelyMaxPerDay(proactivity.rarelyMaxPerDay);
  const day = telegramNotifyDayBucket(now());

  const counters = await readTelegramNotifyCounters(db);
  const sentToday = counters.day === day ? (counters.sentByAgent[candidate.agentId ?? ""] ?? 0) : 0;
  const verdict = decideProactivity({
    mode,
    sentToday,
    rarelyMaxPerDay,
    candidate,
  });
  if (
    verdict.outcome === "allow" &&
    mode === "rarely" &&
    candidate.agentId &&
    !isOwnerDrivenPublicationKey(candidate.idempotencyKey) &&
    !candidate.isReplyToOwner
  ) {
    await mutateTelegramNotifyCounters(db, (current) => {
      const effective =
        current.day === day
          ? current
          : { ...current, version: 1 as const, day, sentByAgent: {} };
      const next: TelegramNotifyCountersDocument = {
        version: 1,
        day,
        sentByAgent: {
          ...effective.sentByAgent,
          [candidate.agentId!]: (effective.sentByAgent[candidate.agentId!] ?? 0) + 1,
        },
        bundledByConversation: effective.bundledByConversation,
      };
      return { next, result: undefined };
    });
  }
  return verdict;
}

/**
 * Queue one bundled proactive text (the `bundle` verdict of the gate) for a
 * conversation. The sweep turns each conversation's queue into one summary
 * publication when the digest window fires.
 */
export async function queueBundledProactivityText(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    issueId: string | null;
    text: string;
  },
  options: { now?: () => Date } = {},
): Promise<void> {
  const now = (options.now ?? (() => new Date()))();
  await mutateTelegramNotifyCounters(db, (current) => {
    const existing = current.bundledByConversation[input.conversationId];
    const texts = [...(existing?.texts ?? []), input.text].slice(
      0,
      MAX_BUNDLED_PROACTIVITY_TEXTS,
    );
    const next: TelegramNotifyCountersDocument = {
      ...current,
      version: 1,
      bundledByConversation: {
        ...current.bundledByConversation,
        [input.conversationId]: {
          companyId: input.companyId,
          endpointId: input.endpointId,
          conversationId: input.conversationId,
          issueId: input.issueId,
          texts,
          lastAt: now.toISOString(),
        },
      },
    };
    return { next, result: undefined };
  });
}

/** Take (and clear) every conversation's bundle queue, oldest first. */
export async function takeBundledProactivityQueues(
  db: Db,
): Promise<BundledProactivityQueue[]> {
  const doc = await mutateTelegramNotifyCounters(db, (current) => {
    if (Object.keys(current.bundledByConversation).length === 0)
      return { next: null, result: [] as BundledProactivityQueue[] };
    const queues = Object.entries(current.bundledByConversation)
      .map(([, queue]) => queue)
      .sort((left, right) => left.lastAt.localeCompare(right.lastAt));
    return {
      next: { ...current, version: 1, bundledByConversation: {} },
      result: queues,
    };
  });
  return doc.result;
}

type Runner = Pick<Db, "select">;

export async function readTelegramNotifyCounters(db: Runner): Promise<TelegramNotifyCountersDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseTelegramNotifyCounters(
    row?.general?.[TELEGRAM_NOTIFY_GENERAL_KEY],
  );
}

/** Read-modify-write our key under a row lock (the canary-store pattern). */
export async function mutateTelegramNotifyCounters<T>(
  db: Db,
  change: (
    current: TelegramNotifyCountersDocument,
  ) => { next: TelegramNotifyCountersDocument | null; result: T },
): Promise<{ doc: TelegramNotifyCountersDocument; result: T; changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = parseTelegramNotifyCounters(
      row.general?.[TELEGRAM_NOTIFY_GENERAL_KEY],
    );
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${TELEGRAM_NOTIFY_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Reset the counters (used by tests and by the bundling sweep). */
export function emptyTelegramNotifyCounters(): TelegramNotifyCountersDocument {
  return { version: 1, day: "", sentByAgent: {}, bundledByConversation: {} };
}