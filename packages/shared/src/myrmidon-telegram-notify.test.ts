// myrmidon(OPE-3789): the telegramNotify contract test — defaults, parsing,
// patch validation. Neutral English only (agent-a, example.com).

import { describe, expect, it } from "vitest";
import {
  TELEGRAM_DIGEST_SECTIONS,
  TELEGRAM_ESCALATION_CHANNELS,
  TELEGRAM_PROACTIVITY_MODES,
  defaultTelegramNotifySettings,
  emptyTelegramNotifyDocument,
  parseTelegramNotifyDocument,
  preserveTelegramNotifyGeneralKey,
  telegramNotifySettingsPatchSchema,
  telegramNotifySettingsSchema,
  type TelegramNotifyDocument,
} from "./myrmidon-telegram-notify.js";

const FULL_DEFAULTS = {
  digest: {
    enabled: false,
    time: "09:00",
    chatId: null,
    topicId: null,
    sections: [...TELEGRAM_DIGEST_SECTIONS],
  },
  errors: { enabled: false, chatId: null, topicId: null, minSeverity: "error", maxPerHour: 10 },
  inbound: { enabled: false, requireMention: true },
  escalations: { enabled: false, hours: 24, channel: "none", chatId: null, topicId: null },
  proactivity: { mode: "only_on_owner_request", rarelyMaxPerDay: 3 },
};

describe("myrmidon(OPE-3789): telegramNotify defaults", () => {
  it("has every section present with every field, all enabled flags off", () => {
    const settings = defaultTelegramNotifySettings();
    expect(settings).toEqual(FULL_DEFAULTS);
    for (const section of ["digest", "errors", "inbound", "escalations"] as const) {
      expect(settings[section].enabled).toBe(false);
    }
  });

  it("passes the full settings schema (the GET answer is valid)", () => {
    expect(telegramNotifySettingsSchema.safeParse(defaultTelegramNotifySettings()).success).toBe(true);
  });
});

describe("myrmidon(OPE-3789): document parsing", () => {
  it("returns defaults for anything that is not a document", () => {
    for (const raw of [null, undefined, 42, "x", [], {}]) {
      expect(parseTelegramNotifyDocument(raw)).toEqual({
        version: 1,
        settings: FULL_DEFAULTS,
        changelog: [],
      });
    }
  });

  it("keeps valid stored values and fills the missing ones with defaults", () => {
    const parsed = parseTelegramNotifyDocument({
      digest: { enabled: true, time: "18:30", chatId: "chat-1" },
      errors: { maxPerHour: 5 },
      inbound: { enabled: true, requireMention: false },
      escalations: { hours: 48, channel: "dm", chatId: "chat-2", topicId: "topic-1" },
      proactivity: { mode: "rarely", rarelyMaxPerDay: 1 },
      changelog: [{ at: "2026-10-03T00:00:00.000Z", actor: "agent-a", field: "digest.enabled", from: false, to: true }],
    });
    expect(parsed.settings.digest).toEqual({
      enabled: true,
      time: "18:30",
      chatId: "chat-1",
      topicId: null,
      sections: [...TELEGRAM_DIGEST_SECTIONS],
    });
    expect(parsed.settings.errors).toEqual({
      enabled: false,
      chatId: null,
      topicId: null,
      minSeverity: "error",
      maxPerHour: 5,
    });
    expect(parsed.settings.inbound).toEqual({ enabled: true, requireMention: false });
    expect(parsed.settings.escalations).toEqual({
      enabled: false,
      hours: 48,
      channel: "dm",
      chatId: "chat-2",
      topicId: "topic-1",
    });
    expect(parsed.settings.proactivity).toEqual({ mode: "rarely", rarelyMaxPerDay: 1 });
    expect(parsed.changelog).toHaveLength(1);
  });

  it("falls back field by field on invalid stored values", () => {
    const parsed = parseTelegramNotifyDocument({
      digest: { time: "25:99", sections: ["nonsense", "blocked"] },
      errors: { minSeverity: "info", maxPerHour: -1 },
      escalations: { hours: 0, channel: "sms" },
      proactivity: { mode: "always", rarelyMaxPerDay: 1.5 },
      changelog: [{ actor: "", field: "digest.enabled" }],
    });
    expect(parsed.settings.digest.time).toBe("09:00");
    // "nonsense" is dropped; the valid "blocked" is kept — per-value filtering, not all-or-nothing.
    expect(parsed.settings.digest.sections).toEqual(["blocked"]);
    expect(parsed.settings.errors.minSeverity).toBe("error");
    expect(parsed.settings.errors.maxPerHour).toBe(10);
    expect(parsed.settings.escalations.hours).toBe(24);
    expect(parsed.settings.escalations.channel).toBe("none");
    expect(parsed.settings.proactivity.mode).toBe("only_on_owner_request");
    expect(parsed.settings.proactivity.rarelyMaxPerDay).toBe(3);
    expect(parsed.changelog).toEqual([]);
  });

  it("preserves the storage key across vendor general writes", () => {
    const doc: TelegramNotifyDocument = emptyTelegramNotifyDocument();
    const general = { other: 1, myrmidonTelegramNotify: { "company-a": doc } };
    expect(preserveTelegramNotifyGeneralKey(general)).toEqual({
      myrmidonTelegramNotify: { "company-a": doc },
    });
    expect(preserveTelegramNotifyGeneralKey({ other: 2 })).toEqual({});
    expect(preserveTelegramNotifyGeneralKey(null)).toEqual({});
  });
});

describe("myrmidon(OPE-3789): the PATCH body schema", () => {
  it("accepts a partial update of one section", () => {
    const result = telegramNotifySettingsPatchSchema.safeParse({ digest: { enabled: true } });
    expect(result.success).toBe(true);
  });

  it("accepts a full multi-section update", () => {
    const result = telegramNotifySettingsPatchSchema.safeParse({
      digest: { enabled: true, time: "12:00", chatId: "chat-1", topicId: null, sections: ["done"] },
      errors: { enabled: true, minSeverity: "warn", maxPerHour: 20 },
      inbound: { requireMention: false },
      escalations: { hours: 12, channel: "topic", topicId: "topic-1" },
      proactivity: { mode: "normal" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty patch", () => {
    expect(telegramNotifySettingsPatchSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown section or an unknown field (strict)", () => {
    expect(telegramNotifySettingsPatchSchema.safeParse({ digestg: {} }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ digest: { colour: "red" } }).success).toBe(false);
  });

  it("rejects values outside the closed enums and ranges", () => {
    expect(telegramNotifySettingsPatchSchema.safeParse({ digest: { time: "9am" } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ digest: { sections: ["nope"] } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ errors: { minSeverity: "info" } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ errors: { maxPerHour: 1.5 } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ escalations: { channel: "sms" } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ escalations: { hours: 0 } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ proactivity: { mode: "always" } }).success).toBe(false);
    expect(telegramNotifySettingsPatchSchema.safeParse({ proactivity: { rarelyMaxPerDay: -1 } }).success).toBe(false);
  });

  it("accepts every documented enum value", () => {
    for (const channel of TELEGRAM_ESCALATION_CHANNELS) {
      expect(telegramNotifySettingsPatchSchema.safeParse({ escalations: { channel } }).success).toBe(true);
    }
    for (const mode of TELEGRAM_PROACTIVITY_MODES) {
      expect(telegramNotifySettingsPatchSchema.safeParse({ proactivity: { mode } }).success).toBe(true);
    }
  });
});
