// myrmidon(TG-NOTIFY-D): TG-NOTIFY settings contract (1.6.1, part A/D shared).
//
// One place for the settings document shape that lives under
// `instance_settings.general.telegramNotify`: the area is runtime-changeable
// owner configuration for the Telegram notification surfaces (digest,
// errors, topic inbound, escalations, head-bot proactivity). Part A owns
// the GET/PATCH routes; this module owns the schema so the server and the
// UI cannot drift. Wire names are fixed by the parent task's contract:
// changes after the agreed version may only ADD fields, never rename.
//
// Defaults are all OFF (the 1.6.1 release criterion): with an absent
// document the owner gets only replies to their own messages and U2
// decision cards. This part (D) consumes only `inbound`.

import { z } from "zod";

/** The `inbound` sub-settings this contract exposes. */
export const telegramNotifyInboundSettingsSchema = z
  .object({
    enabled: z.boolean(),
    requireMention: z.boolean(),
  })
  .strict();

/** channel values shared by `digest`/`errors`/`escalations` (part A). */
export const telegramNotifyChannelSchema = z.enum(["dm", "topic", "none"]);

/** proactivity modes (part A). */
export const telegramNotifyProactivityModeSchema = z.enum([
  "only_on_owner_request",
  "rarely",
  "normal",
]);

/** Full settings document, field-for-field the parent contract's GET body. */
export const telegramNotifySettingsSchema = z
  .object({
    digest: z
      .object({
        enabled: z.boolean(),
        time: z.string(),
        chatId: z.number().int().nullable(),
        topicId: z.number().int().nullable(),
        sections: z.array(
          z.enum(["done", "blocked", "needs_decision", "spend"]),
        ),
      })
      .strict(),
    errors: z
      .object({
        enabled: z.boolean(),
        chatId: z.number().int().nullable(),
        topicId: z.number().int().nullable(),
        minSeverity: z.enum(["error", "warning", "info"]),
        maxPerHour: z.number().int().min(1),
      })
      .strict(),
    inbound: telegramNotifyInboundSettingsSchema,
    escalations: z
      .object({
        enabled: z.boolean(),
        hours: z.number().int().min(1),
        channel: telegramNotifyChannelSchema,
        chatId: z.number().int().nullable(),
        topicId: z.number().int().nullable(),
      })
      .strict(),
    proactivity: z
      .object({
        mode: telegramNotifyProactivityModeSchema,
        rarelyMaxPerDay: z.number().int().min(1),
      })
      .strict(),
  })
  .strict();

/** Partial PATCH body: absent keys keep their stored value (part A route). */
export const telegramNotifySettingsPatchSchema = z
  .object({
    digest: z
      .object({
        enabled: z.boolean().optional(),
        time: z.string().optional(),
        chatId: z.number().int().nullable().optional(),
        topicId: z.number().int().nullable().optional(),
        sections: z
          .array(z.enum(["done", "blocked", "needs_decision", "spend"]))
          .optional(),
      })
      .strict()
      .optional(),
    errors: z
      .object({
        enabled: z.boolean().optional(),
        chatId: z.number().int().nullable().optional(),
        topicId: z.number().int().nullable().optional(),
        minSeverity: z.enum(["error", "warning", "info"]).optional(),
        maxPerHour: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    inbound: telegramNotifyInboundSettingsSchema.partial().optional(),
    escalations: z
      .object({
        enabled: z.boolean().optional(),
        hours: z.number().int().min(1).optional(),
        channel: telegramNotifyChannelSchema.optional(),
        chatId: z.number().int().nullable().optional(),
        topicId: z.number().int().nullable().optional(),
      })
      .strict()
      .optional(),
    proactivity: z
      .object({
        mode: telegramNotifyProactivityModeSchema.optional(),
        rarelyMaxPerDay: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The stored general-settings value defaults (all OFF). */
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

export type TelegramNotifyInboundSettings = z.infer<
  typeof telegramNotifyInboundSettingsSchema
>;
export type TelegramNotifyChannel = z.infer<typeof telegramNotifyChannelSchema>;
export type TelegramNotifyProactivityMode = z.infer<
  typeof telegramNotifyProactivityModeSchema
>;
export type TelegramNotifySettings = z.infer<typeof telegramNotifySettingsSchema>;
export type TelegramNotifySettingsPatch = z.infer<
  typeof telegramNotifySettingsPatchSchema
>;
