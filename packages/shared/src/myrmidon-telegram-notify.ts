// myrmidon(1.6-TG-NOTIFY): the telegramNotify settings contract — one runtime-
// changeable company-level document that says what the board sends to the
// owner in Telegram: the daily digest, error notifications, inbound rules,
// escalation routing and head-bot proactivity.
//
// This module is the shared half of the TG-NOTIFY-SETTINGS core (part A):
// the server stores and serves the document, the board UI edits it, and both
// sides read the same types and zod validators. It contains no I/O and no
// database access on purpose, so the resolver stays unit-testable and the UI
// can validate a PATCH payload before sending it. Parts B–E of the epic
// consume `defaultTelegramNotifySettings()` and `parseTelegramNotifyDocument`
// when they mock this contract in their tests, before the core merges.
//
// Every enabled flag defaults to OFF. With the defaults the owner keeps
// receiving only the replies to their own messages and the U2 decision cards
// (the 1.6.1 release criterion): nothing else is sent to Telegram until the
// board turns a section on.
//
// The contract is fixed at this version. Later changes may only ADD optional
// fields; existing field names are never renamed or repurposed.

import { z } from "zod";

/** The storage key inside `instance_settings.general` (company-keyed map). */
export const TELEGRAM_NOTIFY_GENERAL_KEY = "myrmidonTelegramNotify";

/** The activity-log action prefix every settings mutation is written under. */
export const TELEGRAM_NOTIFY_ACTIVITY_SOURCE = "myrmidon.telegram_notify";

/** How many changelog entries are kept in the document and returned by GET. */
export const TELEGRAM_NOTIFY_CHANGELOG_LIMIT = 200;

// ---------------------------------------------------------------------------
// Enums (closed, additive-only by contract)
// ---------------------------------------------------------------------------

/** Which sections the digest may contain. */
export const TELEGRAM_DIGEST_SECTIONS = ["done", "blocked", "needs_decision", "spend"] as const;

/** Error severities the error gate understands. */
export const TELEGRAM_ERROR_SEVERITIES = ["warn", "error", "fatal"] as const;

/** Where an escalation goes: direct message, topic, or nowhere. */
export const TELEGRAM_ESCALATION_CHANNELS = ["dm", "topic", "none"] as const;

/** How proactive the head bot may be. */
export const TELEGRAM_PROACTIVITY_MODES = ["only_on_owner_request", "rarely", "normal"] as const;

export type TelegramDigestSection = (typeof TELEGRAM_DIGEST_SECTIONS)[number];
export type TelegramErrorSeverity = (typeof TELEGRAM_ERROR_SEVERITIES)[number];
export type TelegramEscalationChannel = (typeof TELEGRAM_ESCALATION_CHANNELS)[number];
export type TelegramProactivityMode = (typeof TELEGRAM_PROACTIVITY_MODES)[number];

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** The daily digest: what happened on the board, once a day, all sections. */
export interface TelegramDigestSettings {
  enabled: boolean;
  /** Local time of day, "HH:MM" 24-hour. */
  time: string;
  chatId: string | null;
  topicId: string | null;
  sections: TelegramDigestSection[];
}

/** Error notifications: runtime and run errors above a severity floor. */
export interface TelegramErrorsSettings {
  enabled: boolean;
  chatId: string | null;
  topicId: string | null;
  minSeverity: TelegramErrorSeverity;
  /** Rate limit: at most this many error notifications per hour. */
  maxPerHour: number;
}

/** Inbound owner messages: whether the bot reacts without an explicit mention. */
export interface TelegramInboundSettings {
  enabled: boolean;
  requireMention: boolean;
}

/** Escalations: work stuck longer than `hours` reaches the owner. */
export interface TelegramEscalationsSettings {
  enabled: boolean;
  hours: number;
  channel: TelegramEscalationChannel;
  chatId: string | null;
  topicId: string | null;
}

/** Head-bot proactivity: whether the bot may write unprompted. */
export interface TelegramProactivitySettings {
  mode: TelegramProactivityMode;
  /** Cap per day when mode is "rarely". */
  rarelyMaxPerDay: number;
}

/** The settings document every company reads and edits. All fields always present. */
export interface TelegramNotifySettings {
  digest: TelegramDigestSettings;
  errors: TelegramErrorsSettings;
  inbound: TelegramInboundSettings;
  escalations: TelegramEscalationsSettings;
  proactivity: TelegramProactivitySettings;
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

/** One recorded settings change: a single field path, its previous and next JSON value. */
export interface TelegramNotifyChangeLogEntry {
  at: string;
  /** Who changed it: a user id or an agent id. */
  actor: string;
  /** The field path, e.g. "digest.enabled" or "errors.maxPerHour". */
  field: string;
  from: unknown;
  to: unknown;
}

/** The stored document: the settings plus the bounded changelog. */
export interface TelegramNotifyDocument {
  version: 1;
  settings: TelegramNotifySettings;
  changelog: TelegramNotifyChangeLogEntry[];
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const chatIdSchema = z.string().min(1).max(200).nullable();
const topicIdSchema = z.string().min(1).max(200).nullable();

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM in 24-hour form");

export const telegramDigestSettingsSchema = z.object({
  enabled: z.boolean(),
  time: timeSchema,
  chatId: chatIdSchema,
  topicId: topicIdSchema,
  sections: z.array(z.enum(TELEGRAM_DIGEST_SECTIONS)),
}).strict();

export const telegramErrorsSettingsSchema = z.object({
  enabled: z.boolean(),
  chatId: chatIdSchema,
  topicId: topicIdSchema,
  minSeverity: z.enum(TELEGRAM_ERROR_SEVERITIES),
  maxPerHour: z.number().int().min(0).max(1000),
}).strict();

export const telegramInboundSettingsSchema = z.object({
  enabled: z.boolean(),
  requireMention: z.boolean(),
}).strict();

export const telegramEscalationsSettingsSchema = z.object({
  enabled: z.boolean(),
  hours: z.number().int().min(1).max(24 * 30),
  channel: z.enum(TELEGRAM_ESCALATION_CHANNELS),
  chatId: chatIdSchema,
  topicId: topicIdSchema,
}).strict();

export const telegramProactivitySettingsSchema = z.object({
  mode: z.enum(TELEGRAM_PROACTIVITY_MODES),
  rarelyMaxPerDay: z.number().int().min(0).max(1000),
}).strict();

export const telegramNotifySettingsSchema = z.object({
  digest: telegramDigestSettingsSchema,
  errors: telegramErrorsSettingsSchema,
  inbound: telegramInboundSettingsSchema,
  escalations: telegramEscalationsSettingsSchema,
  proactivity: telegramProactivitySettingsSchema,
});

export const telegramNotifyChangeLogEntrySchema = z.object({
  at: z.string().min(1),
  actor: z.string().min(1).max(200),
  field: z.string().min(1).max(500),
  from: z.unknown(),
  to: z.unknown(),
});

/**
 * The PATCH body: a partial update of the settings sections. Each section is
 * itself partial (send only the fields you change) and every section key is
 * optional (send only the sections you change), but at least one section must
 * be present.
 */
export const telegramNotifySettingsPatchSchema = z
  .object({
    digest: z.optional(telegramDigestSettingsSchema.partial()),
    errors: z.optional(telegramErrorsSettingsSchema.partial()),
    inbound: z.optional(telegramInboundSettingsSchema.partial()),
    escalations: z.optional(telegramEscalationsSettingsSchema.partial()),
    proactivity: z.optional(telegramProactivitySettingsSchema.partial()),
  })
  .strict()
  .refine(
    (value) =>
      value.digest !== undefined ||
      value.errors !== undefined ||
      value.inbound !== undefined ||
      value.escalations !== undefined ||
      value.proactivity !== undefined,
    { message: "at least one section is required" },
  );

export type TelegramNotifySettingsPatch = z.infer<typeof telegramNotifySettingsPatchSchema>;

// ---------------------------------------------------------------------------
// Defaults and parsing (tolerant: a bad stored value falls back to the default)
// ---------------------------------------------------------------------------

export function defaultTelegramNotifySettings(): TelegramNotifySettings {
  return {
    digest: {
      enabled: false,
      time: "09:00",
      chatId: null,
      topicId: null,
      sections: [...TELEGRAM_DIGEST_SECTIONS],
    },
    errors: {
      enabled: false,
      chatId: null,
      topicId: null,
      minSeverity: "error",
      maxPerHour: 10,
    },
    inbound: {
      enabled: false,
      requireMention: true,
    },
    escalations: {
      enabled: false,
      hours: 24,
      channel: "none",
      chatId: null,
      topicId: null,
    },
    proactivity: {
      mode: "only_on_owner_request",
      rarelyMaxPerDay: 3,
    },
  };
}

/** The empty document: defaults plus an empty changelog. */
export function emptyTelegramNotifyDocument(): TelegramNotifyDocument {
  return { version: 1, settings: defaultTelegramNotifySettings(), changelog: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

function enumValue<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function digestSections(value: unknown): TelegramDigestSection[] {
  const fallback = [...TELEGRAM_DIGEST_SECTIONS];
  if (!Array.isArray(value)) return fallback;
  const parsed = value.filter(
    (entry): entry is TelegramDigestSection =>
      typeof entry === "string" && (TELEGRAM_DIGEST_SECTIONS as readonly string[]).includes(entry),
  );
  return parsed.length > 0 ? parsed : fallback;
}

function digestTime(value: unknown): string {
  return typeof value === "string" && timeSchema.safeParse(value).success ? value : "09:00";
}

/**
 * Parse a stored document into the full contract: every field of every section
 * is always present after this call — an absent or invalid stored value falls
 * back to the default (the repo convention for stored settings), so a corrupt
 * row can never disable a section or produce a partial answer.
 */
export function parseTelegramNotifyDocument(raw: unknown): TelegramNotifyDocument {
  if (!isRecord(raw)) return emptyTelegramNotifyDocument();
  const defaults = defaultTelegramNotifySettings();
  const d = isRecord(raw.digest) ? raw.digest : {};
  const e = isRecord(raw.errors) ? raw.errors : {};
  const i = isRecord(raw.inbound) ? raw.inbound : {};
  const s = isRecord(raw.escalations) ? raw.escalations : {};
  const p = isRecord(raw.proactivity) ? raw.proactivity : {};
  const settings: TelegramNotifySettings = {
    digest: {
      enabled: bool(d.enabled, defaults.digest.enabled),
      time: digestTime(d.time),
      chatId: str(d.chatId),
      topicId: str(d.topicId),
      sections: digestSections(d.sections),
    },
    errors: {
      enabled: bool(e.enabled, defaults.errors.enabled),
      chatId: str(e.chatId),
      topicId: str(e.topicId),
      minSeverity: enumValue(e.minSeverity, TELEGRAM_ERROR_SEVERITIES, defaults.errors.minSeverity),
      maxPerHour: int(e.maxPerHour, defaults.errors.maxPerHour, 0, 1000),
    },
    inbound: {
      enabled: bool(i.enabled, defaults.inbound.enabled),
      requireMention: bool(i.requireMention, defaults.inbound.requireMention),
    },
    escalations: {
      enabled: bool(s.enabled, defaults.escalations.enabled),
      hours: int(s.hours, defaults.escalations.hours, 1, 24 * 30),
      channel: enumValue(s.channel, TELEGRAM_ESCALATION_CHANNELS, defaults.escalations.channel),
      chatId: str(s.chatId),
      topicId: str(s.topicId),
    },
    proactivity: {
      mode: enumValue(p.mode, TELEGRAM_PROACTIVITY_MODES, defaults.proactivity.mode),
      rarelyMaxPerDay: int(p.rarelyMaxPerDay, defaults.proactivity.rarelyMaxPerDay, 0, 1000),
    },
  };
  const changelog = Array.isArray(raw.changelog)
    ? raw.changelog.flatMap((entry): TelegramNotifyChangeLogEntry[] => {
        if (!isRecord(entry)) return [];
        const at = typeof entry.at === "string" ? entry.at : "";
        const actor = str(entry.actor);
        const field = str(entry.field);
        if (!at || !actor || !field) return [];
        return [{ at, actor, field, from: entry.from, to: entry.to }];
      })
    : [];
  return { version: 1, settings, changelog };
}

/** Keep our key across vendor writes of `instance_settings.general`. */
export function preserveTelegramNotifyGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[TELEGRAM_NOTIFY_GENERAL_KEY];
  return value === undefined ? {} : { [TELEGRAM_NOTIFY_GENERAL_KEY]: value };
}

// ---------------------------------------------------------------------------
// myrmidon(1.6-TG-PROACTIVITY-E): proactivity policy contract (merged from main).
// The settings document / patch / defaults above are the part-A contract;
// The names below are the part-E surface the server proactivity policy imports.

/** Proactivity modes of the head bot. */
export const TELEGRAM_NOTIFY_PROACTIVITY_MODES = [
  "only_on_owner_request",
  "rarely",
  "normal",
] as const;

export type TelegramNotifyProactivityMode =
  (typeof TELEGRAM_NOTIFY_PROACTIVITY_MODES)[number];

/** Default mode: the head bot is quiet until the owner asks. */
export const DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE: TelegramNotifyProactivityMode =
  "only_on_owner_request";

/** Default daily ceiling for `rarely`. */
export const DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY = 3;

/** Hard cap for rarelyMaxPerDay; a typo cannot ask for an unbounded day. */
export const MAX_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_PER_DAY = 50;

/**
 * The `proactivity` settings area. The area is part of the fixed part-A
 * contract (`telegramNotify.proactivity`); this module is the single
 * definition so part E and part A converge on the same names.
 */
export const telegramNotifyProactivitySchema = z.object({
  mode: z.enum(TELEGRAM_NOTIFY_PROACTIVITY_MODES),
  rarelyMaxPerDay: z
    .number()
    .int()
    .min(1)
    .max(MAX_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_PER_DAY),
});

export type TelegramNotifyProactivity = z.infer<
  typeof telegramNotifyProactivitySchema
>;

// ---------------------------------------------------------------------------
// Resolution (pure; the server side composes with storage)

/** Agent-metadata key of the per-agent proactivity mode override. */
export const TELEGRAM_NOTIFY_PROACTIVITY_AGENT_METADATA_KEY = "mode";

/**
 * Read the per-agent mode override from an agent's metadata record. The key
 * is `mode` (the same enum); anything that is not one of the modes is
 * ignored — a malformed override never widens proactivity, the company
 * default applies.
 */
export function agentProactivityModeOverride(
  metadata: unknown,
): TelegramNotifyProactivityMode | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const raw = (metadata as Record<string, unknown>)[
    TELEGRAM_NOTIFY_PROACTIVITY_AGENT_METADATA_KEY
  ];
  if (typeof raw !== "string") return null;
  return (TELEGRAM_NOTIFY_PROACTIVITY_MODES as readonly string[]).includes(raw)
    ? (raw as TelegramNotifyProactivityMode)
    : null;
}

/**
 * The effective mode for one agent: the agent's metadata override wins over
 * the company-level default. An agent override can only be one of the three
 * modes — an agent cannot lift itself above the company's `normal`.
 */
export function resolveProactivityMode(
  company: Pick<TelegramNotifyProactivity, "mode">,
  agentMetadata: unknown,
): TelegramNotifyProactivityMode {
  return agentProactivityModeOverride(agentMetadata) ?? company.mode;
}

// ---------------------------------------------------------------------------
// myrmidon(1.6-TG-NOTIFY): the shared JSON contract of the telegramNotify
// settings area. The umbrella task fixes this shape; part A owns the store,
// routes and changelog, part C (this file's `errors` block) consumes it.
//
// Contract notes (fixed by the task, do not rename fields):
//   settings.errors = { enabled, chatId, topicId, minSeverity, maxPerHour }
//   minSeverity: "error" | "warning" — the error channel's own threshold
//   vocabulary, mapped onto attention severities by the server module.
//   maxPerHour: a positive integer rate limit; over the limit, messages are
//   DROPPED, never queued. All defaults are OFF.

/** Severity threshold vocabulary of the errors channel. */
export const TELEGRAM_NOTIFY_SEVERITIES = ["error", "warning"] as const;
export type TelegramNotifySeverity = (typeof TELEGRAM_NOTIFY_SEVERITIES)[number];

export const DEFAULT_TELEGRAM_NOTIFY_ERRORS = {
  enabled: false,
  chatId: null,
  topicId: null,
  minSeverity: "error",
  maxPerHour: 10,
} as const;

export const TELEGRAM_NOTIFY_ERRORS_MAX_PER_HOUR_CEILING = 360;

const telegramNotifyChatTargetSchema = z.object({
  enabled: z.boolean(),
  chatId: z.string().min(1).max(64).nullable(),
  topicId: z.string().min(1).max(64).nullable(),
});

/** The `errors` area of the telegramNotify contract (part C's settings). */
export const telegramNotifyErrorsSchema = telegramNotifyChatTargetSchema
  .extend({
    minSeverity: z.enum(TELEGRAM_NOTIFY_SEVERITIES),
    maxPerHour: z.number().int().min(1).max(TELEGRAM_NOTIFY_ERRORS_MAX_PER_HOUR_CEILING),
  })
  .strict();

export type TelegramNotifyErrorsSettings = z.infer<typeof telegramNotifyErrorsSchema>;

/** PATCH subset of the errors area: absent keys keep their value. */
export const telegramNotifyErrorsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    chatId: z.string().min(1).max(64).nullable().optional(),
    topicId: z.string().min(1).max(64).nullable().optional(),
    minSeverity: z.enum(TELEGRAM_NOTIFY_SEVERITIES).optional(),
    maxPerHour: z.number().int().min(1).max(TELEGRAM_NOTIFY_ERRORS_MAX_PER_HOUR_CEILING).optional(),
  })
  .strict();

export type TelegramNotifyErrorsPatch = z.infer<typeof telegramNotifyErrorsPatchSchema>;

/** Parse a stored/raw value into the canonical errors area, filling safe defaults. */
export function parseTelegramNotifyErrors(raw: unknown): TelegramNotifyErrorsSettings {
  const parsed = telegramNotifyErrorsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Absent or invalid: the safe default — OFF. A hand-edited row never turns
  // the channel on by accident.
  return { ...DEFAULT_TELEGRAM_NOTIFY_ERRORS };
}