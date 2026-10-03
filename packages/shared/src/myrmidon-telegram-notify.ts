// myrmidon(1.6-TG-PROACTIVITY-E): head-bot proactivity policy contract.
//
// Shared half of part E of the TG-NOTIFY-SETTINGS epic (1.6.1): the
// `proactivity` settings area (mode + rarelyMaxPerDay) stored under
// instance settings area `telegramNotify`, plus the same per-agent mode
// override kept in agent metadata under the key `mode`.
//
// This module contains no I/O on purpose: the server resolves the effective
// mode from the document + agent metadata, tests and consumers that cannot
// reach the settings area yet (the area itself is merged by part A) can mock
// the document. Types and zod validators live here so the server and the UI
// read one contract.
//
// The default is the quiet mode: `only_on_owner_request` — with defaults the
// owner receives only replies to their own messages and the U2 decision
// cards; the head bot sends nothing on its own initiative.

import { z } from "zod";

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

/** The whole `telegramNotify` settings document (all areas, defaults off). */
export const telegramNotifySettingsSchema = z.object({
  digest: z.object({
    enabled: z.boolean(),
    time: z.string(),
    chatId: z.string().nullable(),
    topicId: z.string().nullable(),
    sections: z.array(z.string()),
  }),
  errors: z.object({
    enabled: z.boolean(),
    chatId: z.string().nullable(),
    topicId: z.string().nullable(),
    minSeverity: z.string(),
    maxPerHour: z.number().int().min(1),
  }),
  inbound: z.object({
    enabled: z.boolean(),
    requireMention: z.boolean(),
  }),
  escalations: z.object({
    enabled: z.boolean(),
    hours: z.number().int().min(1),
    channel: z.enum(["dm", "topic", "none"]),
    chatId: z.string().nullable(),
    topicId: z.string().nullable(),
  }),
  proactivity: telegramNotifyProactivitySchema,
});

export type TelegramNotifySettings = z.infer<typeof telegramNotifySettingsSchema>;

/** Defaults of the whole document: every new setting is OFF/quiet. */
export function defaultTelegramNotifySettings(): TelegramNotifySettings {
  return {
    digest: {
      enabled: false,
      time: "09:00",
      chatId: null,
      topicId: null,
      sections: ["done", "blocked", "needs_decision", "spend"],
    },
    errors: {
      enabled: false,
      chatId: null,
      topicId: null,
      minSeverity: "error",
      maxPerHour: 10,
    },
    inbound: { enabled: false, requireMention: true },
    escalations: {
      enabled: false,
      hours: 24,
      channel: "none",
      chatId: null,
      topicId: null,
    },
    proactivity: {
      mode: DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_MODE,
      rarelyMaxPerDay:
        DEFAULT_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_MAX_PER_DAY,
    },
  };
}

/**
 * One change-log entry of a settings patch (point 6 of the epic: every
 * change writes an entry; field is a path like `proactivity.mode`).
 */
export interface TelegramNotifyChangelogEntry {
  at: string;
  actor: string;
  field: string;
  from: unknown;
  to: unknown;
}

/** PATCH body: a partial update of the same fields. */
export const telegramNotifySettingsPatchSchema = z
  .object({
    digest: telegramNotifySettingsSchema.shape.digest.partial().optional(),
    errors: telegramNotifySettingsSchema.shape.errors.partial().optional(),
    inbound: telegramNotifySettingsSchema.shape.inbound.partial().optional(),
    escalations: telegramNotifySettingsSchema.shape.escalations.partial().optional(),
    // An area may arrive whole or partial; an unknown key inside an area is
    // still rejected (strict on the inner objects).
    proactivity: z
      .object({
        mode: z.enum(TELEGRAM_NOTIFY_PROACTIVITY_MODES).optional(),
        rarelyMaxPerDay: z
          .number()
          .int()
          .min(1)
          .max(MAX_TELEGRAM_NOTIFY_PROACTIVITY_RARELY_PER_DAY)
          .optional(),
      })
      .strict(),
  })
  .strict();

export type TelegramNotifySettingsPatch = z.infer<
  typeof telegramNotifySettingsPatchSchema
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
