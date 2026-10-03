// myrmidon(UI-RU): fork localization engine on top of the vendor i18next
// foundation. English stays the base language; fork translations live in
// myrmidon-locales/*.json and are deep-merged over the vendor catalog so the
// vendor locale files (42 languages, key parity enforced by the vendor
// validator) never need to be touched. The selected language is persisted in
// localStorage and applied before the first paint of any page load, which is
// the fix for the language resetting on reload.
import { useEffect, useState } from "react";
import type { Resource } from "i18next";

const LANGUAGE_STORAGE_KEY = "myrmidon:ui-language";

/** Languages the fork ships translations for. English is the base. */
export const FORK_LANGUAGES = ["en", "ru"] as const;
export type ForkLanguage = (typeof FORK_LANGUAGES)[number];

const FORK_LANGUAGE_LABELS: Record<ForkLanguage, string> = {
  en: "English",
  ru: "Русский",
};

export function forkLanguageLabel(language: ForkLanguage): string {
  return FORK_LANGUAGE_LABELS[language];
}

export function isForkLanguage(value: unknown): value is ForkLanguage {
  return typeof value === "string" && (FORK_LANGUAGES as readonly string[]).includes(value);
}

export function readStoredLanguage(): ForkLanguage {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isForkLanguage(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode, disabled) — stay on the default.
  }
  return "en";
}

export function storeLanguage(language: ForkLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Persisting is best-effort; the in-memory switch still applies.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merge fork catalog entries over the vendor messages for a locale. */
export function mergeLocaleMessages(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
      merged[key] = mergeLocaleMessages(baseValue, overrideValue);
    } else {
      merged[key] = overrideValue;
    }
  }
  return merged;
}

/**
 * Wrap a vendor locale map so every locale gains the fork catalog: fork
 * languages carry their own translation, every other vendor locale keeps
 * English fork strings (the fork base) until a translation exists.
 */
export function withForkCatalog(
  vendorMessages: Record<string, Record<string, unknown>>,
  forkMessages: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const forkBase = forkMessages.en ?? {};
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [locale, messages] of Object.entries(vendorMessages)) {
    merged[locale] = mergeLocaleMessages(messages, forkBase);
  }
  for (const [locale, messages] of Object.entries(forkMessages)) {
    if (locale === "en") continue;
    merged[locale] = mergeLocaleMessages(merged[locale] ?? forkBase, messages);
  }
  return merged;
}

/** Resolve init resources with the fork catalog merged in. */
export function forkI18nResources(vendorResources: Resource): Resource {
  const forkModules = import.meta.glob("./myrmidon-locales/*.json", {
    eager: true,
    import: "default",
  }) as Record<string, Record<string, unknown>>;
  const forkMessages: Record<string, Record<string, unknown>> = {};
  for (const [path, messages] of Object.entries(forkModules)) {
    const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
    if (locale) forkMessages[locale] = messages;
  }
  const vendorMessages = Object.fromEntries(
    Object.entries(vendorResources).map(([locale, namespaces]) => [
      locale,
      (namespaces as Record<string, Record<string, unknown>>).translation ?? {},
    ]),
  );
  const merged = withForkCatalog(vendorMessages, forkMessages);
  return Object.fromEntries(
    Object.entries(merged).map(([locale, messages]) => [locale, { translation: messages }]),
  ) as Resource;
}

/** Initial language: the persisted choice, applied before i18next.init. */
export function initialForkLanguage(): ForkLanguage {
  return readStoredLanguage();
}

/** Switch the app language and persist the choice. */
export function setAppLanguage(language: ForkLanguage): void {
  storeLanguage(language);
  document.documentElement.lang = language;
}

/**
 * React binding for the current fork language. Re-renders on language change
 * (including changes made in another tab via the storage event).
 */
export function useAppLanguage(): {
  language: ForkLanguage;
  setLanguage: (language: ForkLanguage) => void;
} {
  const [language, setLanguageState] = useState<ForkLanguage>(initialForkLanguage);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === LANGUAGE_STORAGE_KEY && isForkLanguage(event.newValue)) {
        setLanguageState(event.newValue);
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return {
    language,
    setLanguage: (next: ForkLanguage) => {
      setAppLanguage(next);
      setLanguageState(next);
    },
  };
}
