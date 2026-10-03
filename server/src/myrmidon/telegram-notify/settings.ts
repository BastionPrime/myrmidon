// server/src/myrmidon/telegram-notify/settings.ts
//
// myrmidon(1.6.1-TG-NOTIFY-B): the settings contract of the parent track (part A
// owns the routes; this module holds the shape both the routes and the jobs
// share, so the server and later the UI use one contract). Fixed names — the
// parent's contract note: after the agreed version, changes are additive
// only, field names never change.
//
// All defaults are OFF. With the defaults the owner receives in Telegram
// only replies to his own messages and U2 decision cards (release 1.6.1
// criterion). Until part A merges, the default settings reader returns this
// document unchanged: every job reads it, sees `enabled: false`, and sends
// nothing.

/** channel ∈ "dm" | "topic" | "none". */
export type TelegramNotifyEscalationChannel = "dm" | "topic" | "none";

/** mode ∈ "only_on_owner_request" | "rarely" | "normal". */
export type TelegramNotifyProactivityMode =
  | "only_on_owner_request"
  | "rarely"
  | "normal";

export type TelegramNotifyDigestSection = "done" | "blocked" | "needs_decision" | "spend";

export interface TelegramNotifyDigestSettings {
  enabled: boolean;
  /** Send time "HH:MM" (UTC), the fixed default 09:00. */
  time: string;
  /** Telegram chat id the digest is published to; null = not configured. */
  chatId: string | null;
  /** Forum topic id inside that chat; null = the chat itself. */
  topicId: number | null;
  sections: TelegramNotifyDigestSection[];
}

export interface TelegramNotifyErrorsSettings {
  enabled: boolean;
  chatId: string | null;
  topicId: number | null;
  minSeverity: "error" | "warning";
  maxPerHour: number;
}

export interface TelegramNotifyInboundSettings {
  enabled: boolean;
  requireMention: boolean;
}

export interface TelegramNotifyEscalationsSettings {
  enabled: boolean;
  /** Re-send an unanswered agent question after this many hours. */
  hours: number;
  /** Where the re-send goes; "none" = do nothing. */
  channel: TelegramNotifyEscalationChannel;
  chatId: string | null;
  topicId: number | null;
}

export interface TelegramNotifyProactivitySettings {
  mode: TelegramNotifyProactivityMode;
  rarelyMaxPerDay: number;
}

export interface TelegramNotifySettings {
  digest: TelegramNotifyDigestSettings;
  errors: TelegramNotifyErrorsSettings;
  inbound: TelegramNotifyInboundSettings;
  escalations: TelegramNotifyEscalationsSettings;
  proactivity: TelegramNotifyProactivitySettings;
}

/** The all-off document: the exact defaults of the parent's GET contract. */
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
    proactivity: { mode: "only_on_owner_request", rarelyMaxPerDay: 3 },
  };
}
