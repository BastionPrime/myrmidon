// myrmidon(UI-RU): parity and no-English-in-RU guards for the fork catalog.
// The fork localization engine (myrmidon-i18n.ts) merges myrmidon-locales/*.json
// over the vendor catalog; these guards keep that catalog sound:
//   1. en/ru key sets match exactly (a missing key falls back to English on one
//      side and to the key string on the other — both are user-visible).
//   2. ru values contain no untranslated English sentences: latin letter runs
//      are allowed only for names of products, protocols and formats
//      (Myrmidon, Paperclip, PNG, gzip, LAN, VPN, CEO…), placeholders
//      ({{count}}) and punctuation.
// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import en from "./myrmidon-locales/en.json";
import ru from "./myrmidon-locales/ru.json";
import {
  FORK_LANGUAGES,
  mergeLocaleMessages,
  readStoredLanguage,
  setAppLanguage,
  storeLanguage,
  useAppLanguage,
  withForkCatalog,
} from "./myrmidon-i18n";
import { i18n } from "./index";
import { timeAgo } from "@/lib/timeAgo";

function flatten(
  messages: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    } else if (typeof value === "string") {
      out[path] = value;
    }
  }
  return out;
}

// Latin runs that are legitimate in RU copy: product/protocol/format names.
const ALLOWED_LATIN = new Set([
  "Myrmidon", "Paperclip", "Labs", "OpenClaw",
  "PNG", "JPEG", "WEBP", "GIF", "SVG", "gzip",
  "LAN", "VPN", "SSH", "API", "JSON",
  "CEO", "CTO", "CMO", "CFO", "DevOps", "QA", "PM",
  "markdown", "English", "ID", "Swarm",
  // input placeholders stay language-neutral (role codes and URLs)
  "engineer", "https", "example", "com", "changelog",
]);

function unruledLatinRuns(value: string): string[] {
  const withoutPlaceholders = value.replace(/\{\{[^}]+\}\}/g, " ");
  const runs = withoutPlaceholders.match(/[A-Za-z][A-Za-z-]*/g) ?? [];
  return runs.filter((run) => {
    if (run.length <= 1) return false; // single-letter shortcut hints
    if (ALLOWED_LATIN.has(run) || ALLOWED_LATIN.has(run.toUpperCase())) return false;
    if (/^[A-Z]{2,}-?$/.test(run)) return false; // prefix-like tokens (PAP-, ID)
    if (/^[A-Za-z]+-$/.test(run)) return false; // hyphenated compound prefix (Swarm-надзор)
    return true;
  });
}

describe("myrmidon fork i18n catalog", () => {
  it("en and ru expose the same key set", () => {
    const enKeys = Object.keys(flatten(en)).sort();
    const ruKeys = Object.keys(flatten(ru)).sort();
    expect(ruKeys).toEqual(enKeys);
  });

  it("ru values carry no untranslated English wording", () => {
    const flat = flatten(ru);
    const offenders = Object.entries(flat)
      .map(([key, value]) => ({ key, runs: unruledLatinRuns(value) }))
      .filter((entry) => entry.runs.length > 0);
    expect(
      offenders.map(({ key, runs }) => `${key}: ${runs.join(", ")}`),
    ).toEqual([]);
  });

  it("every interpolation placeholder in en exists in ru", () => {
    const enFlat = flatten(en);
    const ruFlat = flatten(ru);
    const placeholder = /\{\{\s*([\w]+)\s*\}\}/g;
    const missing: string[] = [];
    for (const [key, value] of Object.entries(enFlat)) {
      const names = new Set([...value.matchAll(placeholder)].map((m) => m[1]));
      const ruValue = ruFlat[key] ?? "";
      for (const name of names) {
        if (!new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(ruValue)) {
          missing.push(`${key}: {{${name}}}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});


describe("myrmidon fork i18n engine", () => {
  it("mergeLocaleMessages deep-merges the fork catalog over the vendor messages", () => {
    const base = {
      vendor: { keep: "vendor", nested: { a: "a", b: "b" } },
      untouched: "stays",
    };
    const override = {
      vendor: { nested: { b: "B", c: "C" } },
      fork: "new",
    };
    expect(mergeLocaleMessages(base, override)).toEqual({
      vendor: { keep: "vendor", nested: { a: "a", b: "B", c: "C" } },
      untouched: "stays",
      fork: "new",
    });
  });

  it("withForkCatalog carries the fork EN catalog into every vendor locale and RU over EN", () => {
    const vendorMessages = {
      en: { vendor: "v-en" },
      de: { vendor: "v-de" },
    };
    const forkMessages = {
      en: { fork: "F", vendor: "overridden-en" },
      ru: { fork: "Р", vendor: "overridden-ru" },
    };
    const merged = withForkCatalog(vendorMessages, forkMessages);
    expect(merged.en).toEqual({ vendor: "overridden-en", fork: "F" });
    expect(merged.de).toEqual({ vendor: "overridden-en", fork: "F" });
    expect(merged.ru).toEqual({ vendor: "overridden-ru", fork: "Р" });
  });

  it("readStoredLanguage accepts the fork languages, rejects junk and survives a throwing localStorage", () => {
    for (const language of FORK_LANGUAGES) {
      window.localStorage.setItem("myrmidon:ui-language", language);
      expect(readStoredLanguage()).toBe(language);
    }
    window.localStorage.setItem("myrmidon:ui-language", "klingon");
    expect(readStoredLanguage()).toBe("en");
    window.localStorage.clear();

    const throwing = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    };
    vi.spyOn(window, "localStorage", "get").mockReturnValue(throwing as unknown as Storage);
    expect(readStoredLanguage()).toBe("en");
    vi.restoreAllMocks();
  });

  it("setAppLanguage switches the live i18n instance, the document language and storage; the storage-event path does the same", async () => {
    storeLanguage("en");
    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    await setAppLanguage("ru");
    expect(i18n.language).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(window.localStorage.getItem("myrmidon:ui-language")).toBe("ru");

    // cross-tab path: another tab wrote "en"; the storage handler that
    // useAppLanguage registers must move the live instance back, not just
    // the toggle state
    let captured: { language: string } | null = null;
    function Harness() {
      captured = useAppLanguage();
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const { act } = await import("react-dom/test-utils");
    await act(async () => {
      root.render(<Harness />);
    });
    expect(captured!.language).toBe("ru");

    await act(async () => {
      window.localStorage.setItem("myrmidon:ui-language", "en");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "myrmidon:ui-language", newValue: "en" }),
      );
    });
    expect(captured!.language).toBe("en");
    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    await act(async () => {
      root.unmount();
    });
    container.remove();

    await setAppLanguage("en");
  });

  it("timeAgo without a translator reproduces the vendor English output exactly", () => {
    expect(timeAgo(new Date())).toBe("just now");
    const minuteAgo = new Date(Date.now() - 30_000);
    expect(timeAgo(minuteAgo)).toBe("just now");
    const minutesAgo = new Date(Date.now() - 5 * 60_000);
    expect(timeAgo(minutesAgo)).toBe("5m ago");
    const hoursAgo = new Date(Date.now() - 3 * 3_600_000);
    expect(timeAgo(hoursAgo)).toBe("3h ago");
    const daysAgo = new Date(Date.now() - 2 * 86_400_000);
    expect(timeAgo(daysAgo)).toBe("2d ago");
    const weeksAgo = new Date(Date.now() - 3 * 7 * 86_400_000);
    expect(timeAgo(weeksAgo)).toBe("3w ago");
    const monthsAgo = new Date(Date.now() - 40 * 30 * 86_400_000);
    expect(timeAgo(monthsAgo)).toBe("40mo ago");
  });

  it("timeAgo with a translator uses the fork keys and interpolates count", () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const t = (key: string, options?: Record<string, unknown>) => {
      calls.push([key, options]);
      return `${key}:${options?.count ?? ""}`;
    };
    expect(timeAgo(new Date(), t)).toBe("time.justNow:");
    expect(timeAgo(new Date(Date.now() - 5 * 60_000), t)).toBe("time.minutesAgo:5");
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000), t)).toBe("time.hoursAgo:3");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000), t)).toBe("time.daysAgo:2");
    expect(timeAgo(new Date(Date.now() - 3 * 7 * 86_400_000), t)).toBe("time.weeksAgo:3");
    expect(timeAgo(new Date(Date.now() - 40 * 30 * 86_400_000), t)).toBe("time.monthsAgo:40");
  });
});
