// ui/src/api/myrmidonTelegramNotify.ts
//
// myrmidon(OPE-3789): API client for the telegramNotify settings — the UI
// half of the TG-NOTIFY-SETTINGS contract. The server core (part A) serves
// `GET /api/myrmidon/telegram-notify` (company access; the companyId query
// parameter first, then the single active company membership) and
// `PATCH /api/myrmidon/telegram-notify` (board only). The types come from
// @paperclipai/shared so the UI and the core cannot drift; while the core
// half is unmerged the tests mock this module and assert the JSON contract.

import type {
  TelegramNotifySettings,
  TelegramNotifySettingsPatch,
} from "@paperclipai/shared";
import { api } from "./client";

/** What GET/PATCH answer: the settings plus the bounded change log. */
export interface TelegramNotifyView {
  settings: TelegramNotifySettings;
  changelog: TelegramNotifyChangeLogEntryView[];
}

export interface TelegramNotifyChangeLogEntryView {
  at: string;
  actor: string;
  field: string;
  from: unknown;
  to: unknown;
}

export const telegramNotifyQueryKey = (companyId: string) =>
  ["myrmidon", "telegram-notify", companyId] as const;

export const telegramNotifyApi = {
  get: (companyId: string) =>
    api.get<TelegramNotifyView>(`/myrmidon/telegram-notify?companyId=${encodeURIComponent(companyId)}`),
  update: (companyId: string, patch: TelegramNotifySettingsPatch) =>
    api.patch<TelegramNotifyView>(`/myrmidon/telegram-notify?companyId=${encodeURIComponent(companyId)}`, patch),
};