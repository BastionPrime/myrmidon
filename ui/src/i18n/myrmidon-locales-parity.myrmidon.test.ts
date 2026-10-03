// myrmidon(UI-RU): catalog parity and completeness guards for the fork
// localization catalog of the legacy board shell (myrmidon-locales). Fails on:
//   - a key missing from EN or RU (exact key-set parity);
//   - an empty or whitespace-only RU value (the RU catalog must carry real
//     translations);
//   - an RU value that looks like untranslated English (Latin-only letters,
//     ignoring values that are legitimately neutral: unit suffixes, key codes,
//     URLs, role/placeholder codes);
//   - interpolation placeholders that differ between EN and RU.
import { describe, expect, it } from "vitest";
import en from "./myrmidon-locales/en.json";
import ru from "./myrmidon-locales/ru.json";

function flatten(
  source: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; value: unknown }> {
  const result: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result.push(...flatten(value as Record<string, unknown>, path));
    } else {
      result.push({ key: path, value });
    }
  }
  return result;
}

const flatEn = flatten(en);
const flatRu = flatten(ru);
const enKeys = new Set(flatEn.map((entry) => entry.key));
const ruKeys = new Set(flatRu.map((entry) => entry.key));

function placeholders(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(value.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)).map((m) => m[1]).sort();
}

// RU values that are legitimately Latin-only: unit/code tokens, role
// acronyms, the English language's own name, and input placeholders the
// catalog intentionally keeps language-neutral.
const NEUTRAL_VALUE = new Set([
  "h", "s", "min", "URL", "API", "BASELINE", "Pilot", "—", "-", "to",
  "English", "ID", "CEO", "CTO", "CMO", "CFO", "PM", "QA", "DevOps",
  "engineer", "https://example.com/changelog",
]);

const LATIN_ONLY = /^[A-Za-z0-9 .,:;/()&+%-]+$/;

describe("fork i18n catalog parity (myrmidon-locales)", () => {
  it("has the exact same key set in EN and RU", () => {
    const missingInRu = [...enKeys].filter((key) => !ruKeys.has(key));
    const missingInEn = [...ruKeys].filter((key) => !enKeys.has(key));
    expect(
      { missingInRu, missingInEn },
      "every fork catalog key must exist in both EN and RU",
    ).toEqual({ missingInRu: [], missingInEn: [] });
  });

  it("carries non-empty RU values", () => {
    const empty = flatRu
      .filter((entry) => typeof entry.value !== "string" || entry.value.trim().length === 0)
      .map((entry) => entry.key);
    expect(empty, "RU values must be non-empty strings").toEqual([]);
  });

  it("carries translated RU values (no Latin-only English leftovers)", () => {
    const englishLooking = flatRu
      .filter((entry) => typeof entry.value === "string")
      .map((entry) => ({ key: entry.key, value: entry.value as string }))
      .filter((entry) => LATIN_ONLY.test(entry.value) && !NEUTRAL_VALUE.has(entry.value))
      .map((entry) => `${entry.key} = ${entry.value}`);
    expect(
      englishLooking,
      "RU values must contain Cyrillic or be a known neutral token",
    ).toEqual([]);
  });

  it("keeps interpolation placeholders identical between EN and RU", () => {
    const ruBykey = new Map(flatRu.map((entry) => [entry.key, entry.value]));
    const drift = flatEn
      .filter((entry) => {
        const enPh = placeholders(entry.value);
        const ruPh = placeholders(ruBykey.get(entry.key));
        return enPh.join("\u0000") !== ruPh.join("\u0000");
      })
      .map((entry) => entry.key);
    expect(drift, "placeholders must match between EN and RU").toEqual([]);
  });
});
