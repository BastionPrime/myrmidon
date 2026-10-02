// myrmidon(UI2-I18N): catalog parity and completeness guards for the 2.0 UI
// tree. Fails on:
//   - a key missing from EN or RU (exact key-set parity);
//   - an empty or whitespace-only RU value (the RU catalog must carry real
//     translations);
//   - an RU value that looks like untranslated English (Latin-only letters);
//   - interpolation placeholders that differ between EN and RU.
import { describe, expect, it } from "vitest";
import { en } from "./catalogs/en";
import { ru } from "./catalogs/ru";

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
  return Array.from(value.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g), (m) => m[1]).sort();
}

describe("ui2 i18n catalog parity", () => {
  it("has the exact same key set in EN and RU", () => {
    const missingInRu = [...enKeys].filter((key) => !ruKeys.has(key));
    const missingInEn = [...ruKeys].filter((key) => !enKeys.has(key));
    expect(
      { missingInRu, missingInEn },
      "every ui2 catalog key must exist in both EN and RU",
    ).toEqual({ missingInRu: [], missingInEn: [] });
  });

  it("carries non-empty RU values", () => {
    const empty = flatRu
      .filter((entry) => typeof entry.value !== "string" || entry.value.trim().length === 0)
      .map((entry) => entry.key);
    expect(empty, "RU values must be non-empty strings").toEqual([]);
  });

  it("carries no untranslated English in RU values", () => {
    // A Russian value must contain Cyrillic unless it is a known shared
    // token (language names, role acronyms).
    const allowLatinOnly = new Set(["English", "Русский", "CEO", "CFO", "CMO", "CTO", "QA", "DevOps"]);
    const englishLooking = flatRu
      .filter((entry) => typeof entry.value === "string")
      .filter((entry) => {
        const value = entry.value as string;
        const hasCyrillic = /[\u0400-\u04FF]/.test(value);
        const hasLatinLetters = /[A-Za-z]{2,}/.test(value);
        return !hasCyrillic && hasLatinLetters && !allowLatinOnly.has(value.trim());
      })
      .map((entry) => `${entry.key} -> ${entry.value as string}`);
    expect(
      englishLooking,
      "RU values must be translated (Latin-only words are suspicious unless allowlisted)",
    ).toEqual([]);
  });

  it("keeps interpolation placeholders identical between EN and RU", () => {
    const mismatched: Array<string> = [];
    for (const entry of flatEn) {
      const ruValue = flatRu.find((candidate) => candidate.key === entry.key)?.value;
      const enPlaceholders = placeholders(entry.value).join(",");
      const ruPlaceholders = placeholders(ruValue).join(",");
      if (enPlaceholders !== ruPlaceholders) {
        mismatched.push(
          `${entry.key}: en(${enPlaceholders}) ru(${ruPlaceholders})`,
        );
      }
    }
    expect(mismatched, "placeholder sets must match exactly").toEqual([]);
  });

  it("has no duplicate keys inside each catalog after flattening", () => {
    expect(flatEn.length, "EN keys").toBe(enKeys.size);
    expect(flatRu.length, "RU keys").toBe(ruKeys.size);
  });
});
