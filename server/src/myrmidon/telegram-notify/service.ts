// myrmidon(OPE-3789): telegram-notify settings service (part A) — apply a
// partial PATCH, record every changed field in the changelog.
//
// The service owns the merge rule and takes its storage seam by injection
// (`TelegramNotifyStore`), so the same code runs in production over
// instance_settings and in tests over an in-memory store. It never throws
// HTTP errors itself: the route layer maps the typed failures onto status
// codes. A patch that changes nothing is accepted and answers 200 with the
// current document — no changelog noise for a no-op write.
//
// Cross-field rules kept here (the shape itself is validated by the shared
// zod schema before the service sees the body):
// - a digest/errors/escalations section that is turned ON with channel
//   "topic" (escalations) may keep its ids: the consumers read them only
//   when the section is enabled, and an operator may pre-fill the ids while
//   the section is still off. The service does not second-guess that.

import {
  TELEGRAM_NOTIFY_CHANGELOG_LIMIT,
  emptyTelegramNotifyDocument,
  type TelegramNotifyChangeLogEntry,
  type TelegramNotifyDocument,
  type TelegramNotifySettings,
  type TelegramNotifySettingsPatch,
} from "@paperclipai/shared";
import type { TelegramNotifyStore } from "./store.js";

/** A typed refusal the route layer turns into an HTTP status. */
export type TelegramNotifyFailure =
  | { kind: "invalid_section_key"; section: string; key: string }
  | { kind: "unknown_field"; section: string; key: string };

export type TelegramNotifyResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: TelegramNotifyFailure };

/** The document the GET route returns: settings plus the bounded changelog. */
export type TelegramNotifySnapshot = {
  settings: TelegramNotifySettings;
  changelog: TelegramNotifyChangeLogEntry[];
};

export interface TelegramNotifyServiceDeps {
  store: TelegramNotifyStore;
  now?: () => Date;
}

type SectionKey = keyof TelegramNotifySettingsPatch;
const SECTION_KEYS = ["digest", "errors", "inbound", "escalations", "proactivity"] as const;

/**
 * The merge rule: an explicit value in the patch replaces the stored value,
 * an absent key keeps it. Both objects are plain (zod-validated) records, so
 * a field-by-field merge is exact and never invents a value.
 */
function mergeSettings(
  current: TelegramNotifySettings,
  patch: TelegramNotifySettingsPatch,
): { settings: TelegramNotifySettings; changes: TelegramNotifyChangeLogEntry[] } {
  const settings = structuredClone(current) as TelegramNotifySettings;
  const changes: TelegramNotifyChangeLogEntry[] = [];
  for (const section of SECTION_KEYS) {
    const patchSection = patch[section];
    if (patchSection === undefined) continue;
    const stored = settings[section] as unknown as Record<string, unknown>;
    const updates = patchSection as unknown as Record<string, unknown>;
    for (const key of Object.keys(updates)) {
      if (!(key in stored)) continue;
      const from = stored[key];
      const to = updates[key];
      if (Object.is(from, to)) continue;
      stored[key] = to;
      changes.push({
        at: "",
        actor: "",
        field: `${section}.${key}`,
        from: from === undefined ? null : from,
        to: to === undefined ? null : to,
      });
    }
  }
  return { settings, changes };
}

export function telegramNotifyService(deps: TelegramNotifyServiceDeps) {
  const now = () => deps.now?.() ?? new Date();

  async function snapshot(companyId: string): Promise<TelegramNotifySnapshot> {
    const document = await deps.store.read(companyId);
    return {
      settings: document.settings,
      changelog: document.changelog.slice(0, TELEGRAM_NOTIFY_CHANGELOG_LIMIT),
    };
  }

  async function update(
    companyId: string,
    actor: string,
    patch: TelegramNotifySettingsPatch,
  ): Promise<TelegramNotifyResult<TelegramNotifySnapshot>> {
    const { result } = await deps.store.mutate<TelegramNotifyResult<TelegramNotifySnapshot>>(
      companyId,
      (current) => {
        const { settings, changes } = mergeSettings(current.settings, patch);
        if (changes.length === 0) {
          return { next: null, result: { ok: true, value: { settings: current.settings, changelog: current.changelog } } };
        }
        const at = now().toISOString();
        const changelog = [
          ...changes.map((entry) => ({ ...entry, at, actor })),
          ...current.changelog,
        ].slice(0, TELEGRAM_NOTIFY_CHANGELOG_LIMIT);
        const next: TelegramNotifyDocument = { version: 1, settings, changelog };
        return {
          next,
          result: { ok: true, value: { settings, changelog: changelog.slice(0, TELEGRAM_NOTIFY_CHANGELOG_LIMIT) } },
        };
      },
    );
    return result;
  }

  return { snapshot, update };
}

/** Exported for tests: the merge rule with an empty actor, so the diff can be asserted directly. */
export function applyTelegramNotifyPatch(
  current: TelegramNotifyDocument,
  patch: TelegramNotifySettingsPatch,
): TelegramNotifyDocument {
  const { settings, changes } = mergeSettings(current.settings, patch);
  if (changes.length === 0) return current;
  const changelog = [...changes.map((entry) => ({ ...entry, at: "", actor: "" })), ...current.changelog].slice(
    0,
    TELEGRAM_NOTIFY_CHANGELOG_LIMIT,
  );
  return { version: 1, settings, changelog };
}

export { emptyTelegramNotifyDocument };
