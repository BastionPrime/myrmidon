// ui/src/ui2/i18n/Ui2I18n.tsx
//
// myrmidon(UI2): the language provider for the ui2 tree. The persistence
// model is intentionally minimal for the first slice: the chosen locale is
// stored client-side (`localStorage`, key `myrmidon.ui2.locale`) and applied
// on mount before the first paint of a ui2 screen. Server-side per-user
// persistence is the i18n part's scope; when that lands, this provider's
// `readStoredLocale` is the single seam to swap for an API read.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  UI2_DEFAULT_LOCALE,
  UI2_LOCALES,
  formatUi2Message,
  ui2Messages,
  type Ui2Locale,
  type Ui2MessageKey,
} from "./locales";

const STORAGE_KEY = "myrmidon.ui2.locale";

export function isUi2Locale(value: unknown): value is Ui2Locale {
  return typeof value === "string" && (UI2_LOCALES as readonly string[]).includes(value);
}

/** Read the stored locale without crashing on private-mode/quota failures. */
export function readStoredLocale(): Ui2Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isUi2Locale(raw) ? raw : null;
  } catch {
    return null;
  }
}

function persistLocale(locale: Ui2Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this session.
  }
}

export interface Ui2I18nContextValue {
  locale: Ui2Locale;
  setLocale: (locale: Ui2Locale) => void;
  t: (key: Ui2MessageKey, values?: Record<string, string | number>) => string;
}

const Ui2I18nContext = createContext<Ui2I18nContextValue | null>(null);

export function Ui2I18nProvider({
  children,
  initialLocale = readStoredLocale() ?? UI2_DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: Ui2Locale;
}) {
  const [locale, setLocaleState] = useState<Ui2Locale>(initialLocale);

  const setLocale = useCallback((next: Ui2Locale) => {
    persistLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<Ui2I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => {
        const template = ui2Messages[locale][key] ?? ui2Messages[UI2_DEFAULT_LOCALE][key] ?? key;
        return formatUi2Message(template, values);
      },
    }),
    [locale, setLocale],
  );

  return <Ui2I18nContext.Provider value={value}>{children}</Ui2I18nContext.Provider>;
}

export function useUi2I18n(): Ui2I18nContextValue {
  const ctx = useContext(Ui2I18nContext);
  if (!ctx) throw new Error("useUi2I18n requires a Ui2I18nProvider ancestor");
  return ctx;
}
