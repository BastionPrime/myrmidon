// ui/src/ui2/tests/ui2.i18n.myrmidon.test.ts
//
// myrmidon(UI2): the i18n guard for the ui2 tree:
//   - en/ru catalogs have identical key sets;
//   - interpolation placeholders match between en and ru;
//   - the format helper substitutes values and leaves unknown keys intact;
//   - no English literal leaks into the RU catalog: every ru string that
//     consists solely of ASCII letters, digits and punctuation is rejected,
//     except the two intentional brand terms (English / Русский labels
//     themselves keep their native names in both catalogs).
// Red side: dropping a ru key or swapping a placeholder in ru fails here.

import { describe, expect, it } from "vitest";
import {
  UI2_DEFAULT_LOCALE,
  UI2_LOCALES,
  formatUi2Message,
  ui2Messages,
  type Ui2MessageKey,
} from "../i18n/locales";
import { isUi2Locale, readStoredLocale } from "../i18n/Ui2I18n";

const en = ui2Messages.en;
const ru = ui2Messages.ru;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function placeholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER_RE), (match) => match[1]).sort();
}

/** Strings allowed to stay ASCII-only in RU: language self-names. */
const RU_ASCII_ALLOWLIST = new Set(["English"]);

describe("myrmidon(UI2) locale catalog parity", () => {
  it("ships exactly the two ui2 locales with en as the default", () => {
    expect(UI2_LOCALES).toEqual(["en", "ru"]);
    expect(UI2_DEFAULT_LOCALE).toBe("en");
  });

  it("has identical key sets in en and ru", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps interpolation placeholders identical between en and ru", () => {
    for (const key of Object.keys(en) as Ui2MessageKey[]) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("leaves no ASCII-only string in the ru catalog outside the allowlist", () => {
    for (const key of Object.keys(ru) as Ui2MessageKey[]) {
      const value = ru[key];
      const hasCyrillic = /[А-Яа-яЁё]/.test(value);
      // A pure placeholder template ({{x}} plus data separators like
      // ": ", " / ", "%") is data plumbing, not copy — e.g. the fact-check
      // row "{{label}}: {{value}}" renders agent-written values.
      const isPureTemplate =
        /^[\s{}A-Za-z0-9_.%:/+()·-]*$/.test(value) && /\{\{/.test(value);
      const asciiOnly = /^[\x20-\x7E]*$/.test(value);
      if (asciiOnly && !hasCyrillic && !isPureTemplate) {
        expect(RU_ASCII_ALLOWLIST, key).toContain(value);
      }
    }
  });
});

describe("myrmidon(UI2) formatUi2Message", () => {
  it("substitutes placeholders with string and number values", () => {
    expect(formatUi2Message("Agent {{agent}} ({{count}})", { agent: "agent-a", count: 3 })).toBe(
      "Agent agent-a (3)",
    );
  });

  it("keeps unknown placeholders intact instead of dropping them", () => {
    expect(formatUi2Message("Value {{missing}}", {})).toBe("Value {{missing}}");
  });

  it("interpolates the real catalog keys used by the screens", () => {
    expect(en["ui2.decisions.queue.count"]).toContain("{{count}}");
    expect(formatUi2Message(en["ui2.decisions.queue.count"], { count: 5 })).toBe("5 waiting");
    expect(formatUi2Message(ru["ui2.decisions.queue.count"], { count: 5 })).toBe("5 ждут");
  });
});

describe("myrmidon(UI2) locale plumbing", () => {
  it("accepts only the two known locales", () => {
    expect(isUi2Locale("en")).toBe(true);
    expect(isUi2Locale("ru")).toBe(true);
    expect(isUi2Locale("de")).toBe(false);
    expect(isUi2Locale(null)).toBe(false);
  });

  it("reads the stored locale only when it is a known one", () => {
    // jsdom/localStorage is not present in the node environment; the guard
    // must return null rather than throw.
    expect(readStoredLocale()).toBeNull();
  });
});
