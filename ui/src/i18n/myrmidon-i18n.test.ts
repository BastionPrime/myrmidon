// myrmidon(UI-RU): parity and no-English-in-RU guards for the fork catalog.
// The fork localization engine (myrmidon-i18n.ts) merges myrmidon-locales/*.json
// over the vendor catalog; these guards keep that catalog sound:
//   1. en/ru key sets match exactly (a missing key falls back to English on one
//      side and to the key string on the other — both are user-visible).
//   2. ru values contain no untranslated English sentences: latin letter runs
//      are allowed only for names of products, protocols and formats
//      (Myrmidon, Paperclip, PNG, gzip, LAN, VPN, CEO…), placeholders
//      ({{count}}) and punctuation.
import { describe, expect, it } from "vitest";
import en from "./myrmidon-locales/en.json";
import ru from "./myrmidon-locales/ru.json";

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
