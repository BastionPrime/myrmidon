// myrmidon(UI2-I18N): language provider for the 2.0 UI tree (ui/src/ui2).
//
// Owns the user's interface language end to end for the new tree:
//   - the server preference (`GET/PUT /api/myrmidon/ui2/language/me`) is the
//     source of truth — the choice follows the user across browsers;
//   - localStorage mirrors the last applied choice so a reload keeps the
//     language before the request resolves (and when the request fails);
//   - the ui2 catalogs are registered on the vendor i18next instance via
//     addResourceBundle as the "ui2" namespace — the vendor locale JSON and
//     the vendor i18n module stay untouched (no vendor-file edits at all);
//   - the `lang` attribute is set on the ui2 root element (en/ru): that
//     attribute is the whole font-switch contract with the shell theme
//     (Saira for EN, Exo 2 for RU, keyed on [lang="ru"] in tokens.css);
//   - cross-tab sync via the storage event.
//
// The provider is shell-agnostic: the shell root mounts it as one line (the
// cross-ticket contract), and the vendor screens are unaffected — vendor
// translation behavior does not change (English default, same keys).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { i18n } from "@/i18n";
import { UI2_LANGUAGES, type Ui2Language } from "@paperclipai/shared";
import { ui2LanguageApi } from "./api";
import { en } from "./catalogs/en";
import { ru } from "./catalogs/ru";

export { UI2_LANGUAGES };
export type { Ui2Language };

const UI2_LANGUAGE_STORAGE_KEY = "myrmidon:ui2:language";
const UI2_NAMESPACE = "ui2";

export function isUi2Language(value: unknown): value is Ui2Language {
  return typeof value === "string" && (UI2_LANGUAGES as readonly string[]).includes(value);
}

function readStoredLanguage(): Ui2Language | null {
  try {
    const stored = window.localStorage.getItem(UI2_LANGUAGE_STORAGE_KEY);
    if (isUi2Language(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode, disabled) — rely on the server.
  }
  return null;
}

function storeLanguage(language: Ui2Language): void {
  try {
    window.localStorage.setItem(UI2_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Persisting locally is best-effort; the server copy still applies.
  }
}

export function ui2LanguageLabel(language: Ui2Language): string {
  return language === "ru" ? "Русский" : "English";
}

/** The ui2 catalogs keyed by locale, registered via addResourceBundle. */
export const ui2Catalogs = { en, ru } as const;

/**
 * Register the ui2 catalogs on the i18next instance (idempotent). The fork
 * languages carry their own catalog; every other vendor locale falls back to
 * the English base through i18next's fallback chain.
 */
export function registerUi2Catalogs(): void {
  for (const [locale, catalog] of Object.entries(ui2Catalogs)) {
    if (!i18n.hasResourceBundle(locale, UI2_NAMESPACE)) {
      i18n.addResourceBundle(locale, UI2_NAMESPACE, catalog, true, true);
    }
  }
}

/**
 * The ui2 root element the `lang` attribute goes on (the shell mounts one
 * element with class "myr-ui2"). Falls back to documentElement outside the
 * shell (tests, standalone panels) so the attribute contract still holds.
 */
function ui2LangRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(".myr-ui2") ?? document.documentElement;
}

/** Apply a language: persist locally, set lang on the ui2 root, switch i18n. */
export function applyUi2Language(language: Ui2Language): void {
  storeLanguage(language);
  const root = ui2LangRoot();
  if (root) root.setAttribute("lang", language);
  void i18n.changeLanguage(language);
}

export interface Ui2LanguageContextValue {
  language: Ui2Language;
  /** Switch language: server write (when possible) + immediate apply. */
  setLanguage: (language: Ui2Language) => void;
  /** True while the preference PUT is in flight. */
  saving: boolean;
  /** Set when the server write failed (choice stays local only). */
  saveError: boolean;
}

const Ui2LanguageContext = createContext<Ui2LanguageContextValue | undefined>(undefined);

export function Ui2LanguageProvider({ children }: { children: ReactNode }) {
  // Start from the mirrored local choice so the first paint keeps the
  // language even before the server preference resolves.
  const [language, setLanguageState] = useState<Ui2Language>(() => readStoredLanguage() ?? "en");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const mounted = useRef(true);
  // Once the user has chosen a language in this session, a late server
  // response must not overwrite their choice (the switch already applied
  // and queued its own write).
  const userSwitched = useRef(false);

  useEffect(() => {
    mounted.current = true;
    registerUi2Catalogs();
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load the server preference once: it wins over the local mirror — but
  // only until the user switches in this session.
  useEffect(() => {
    let cancelled = false;
    ui2LanguageApi
      .get()
      .then((preference) => {
        if (cancelled || userSwitched.current || !isUi2Language(preference?.language)) return;
        setLanguageState(preference.language);
        applyUi2Language(preference.language);
      })
      .catch(() => {
        // Offline or not a board session: keep the local mirror.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === UI2_LANGUAGE_STORAGE_KEY && isUi2Language(event.newValue)) {
        setLanguageState(event.newValue);
        applyUi2Language(event.newValue);
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setLanguage = useCallback((next: Ui2Language) => {
    userSwitched.current = true;
    setSaveError(false);
    setSaving(true);
    applyUi2Language(next);
    setLanguageState(next);
    ui2LanguageApi
      .put(next)
      .then(() => {
        if (mounted.current) setSaving(false);
      })
      .catch(() => {
        // The language stays applied locally; flag that the server copy
        // was not saved.
        if (mounted.current) {
          setSaving(false);
          setSaveError(true);
        }
      });
  }, []);

  const value = useMemo<Ui2LanguageContextValue>(
    () => ({ language, setLanguage, saving, saveError }),
    [language, setLanguage, saving, saveError],
  );

  return <Ui2LanguageContext.Provider value={value}>{children}</Ui2LanguageContext.Provider>;
}

export function useUi2Language(): Ui2LanguageContextValue {
  const context = useContext(Ui2LanguageContext);
  if (!context) {
    throw new Error("useUi2Language must be used inside Ui2LanguageProvider");
  }
  return context;
}
