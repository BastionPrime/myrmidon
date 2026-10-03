// myrmidon(UI2-I18N): static guard — no hard-coded user-visible strings in
// the 2.0 UI tree, and no t() call for a key the catalogs do not carry.
//
// Scans ui/src/ui2/**/*.{ts,tsx} (excluding tests) for:
//   - JSX text children that are literal words (not {expressions});
//   - user-visible string attributes (title, aria-label, placeholder, label,
//     alt, aria-describedby, aria-labelledby) with literal English text;
//   - string literals passed to data-testid-style attributes are allowed
//     (machine-facing), as are classNames, ids, keys, values, names, types,
//     import/export machinery and URL-ish tokens.
//   - every `t("<key>")` literal must exist in BOTH the EN and RU catalogs.
//
// The vendor tree is out of scope here: the legacy shell translations are a
// separate track (UI-RU). This guard owns the 2.0 tree only.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "./catalogs/en";
import { ru } from "./catalogs/ru";
import { ui2Messages } from "./locales";

const UI2_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_FILE = (name: string) =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx") || name.startsWith(".");

function listSourceFiles(dir: string): Array<string> {
  const result: Array<string> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      result.push(...listSourceFiles(path));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(name.slice(name.lastIndexOf("."))) && !SKIP_FILE(name)) {
      result.push(path);
    }
  }
  return result;
}

function flatten(source: Record<string, unknown>, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of flatten(value as Record<string, unknown>, path)) keys.add(nested);
    } else {
      keys.add(path);
    }
  }
  return keys;
}

const catalogKeys = flatten(en);
const ruKeys = flatten(ru);
// The re-skin screens carry their copy in the flat ui2.* catalog of
// locales.ts (UI2 re-skin); the guard must accept keys from BOTH catalogs —
// the nested ui2: namespace (UI2-I18N panels) and the flat screen catalog.
for (const key of Object.keys(ui2Messages.en)) catalogKeys.add(key);
for (const key of Object.keys(ui2Messages.ru)) ruKeys.add(key);

/** Attributes whose string values a human reads. */
const USER_VISIBLE_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "placeholder",
  "alt",
  "label",
]);

/** Attributes whose values are machine-facing, ID references or routing-only. */
const MACHINE_ATTRIBUTES = new Set([
  "className",
  "class",
  "id",
  "key",
  "value",
  "name",
  "type",
  "data-testid",
  "data-selected",
  "role",
  "htmlFor",
  "src",
  "href",
  "to",
  "path",
  "queryKey",
  "initialData",
  "variant",
  "size",
  "onChange",
  "onClick",
  // ID references into the DOM, not human-readable text.
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
]);

const WORDISH = /[A-Za-z]{3,}/;

/** True when the text reads like prose, not an identifier or generic call. */
function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // A single identifier-like token (no spaces, dots/case mixed) is machine
  // facing: generics in TS (`>(T)<`), keys, test ids.
  const identifierLike = /^[A-Za-z0-9_.:-]+$/.test(trimmed);
  return !identifierLike && WORDISH.test(trimmed);
}

interface Violation {
  file: string;
  line: number;
  kind: "jsx-text" | "attribute";
  excerpt: string;
}

function scanFile(path: string): Array<Violation> {
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  const violations: Array<Violation> = [];
  const relative = path.slice(UI2_ROOT.length + 1);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    // Skip import/export lines, comments and pure type declarations.
    const trimmed = line.trim();
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("} from")
    ) {
      return;
    }

    // JSX text children: `> Words here <` between tags. Identifier-like
    // single tokens are machine-facing (TS generics `>(T)<`, keys).
    // A `>` that belongs to an arrow (`=>`) is code, not markup: with a
    // comparison `<` later on the same line the pair would otherwise read
    // as a JSX text node (useIsMobileViewport precedent).
    for (const match of line.matchAll(/(?<!=)>([^<>{}]+)</g)) {
      const text = match[1].trim();
      if (looksLikeProse(text)) {
        violations.push({ file: relative, line: lineNumber, kind: "jsx-text", excerpt: text });
      }
    }

    // User-visible string attributes.
    for (const match of line.matchAll(/([A-Za-z-]+)\s*=\s*"([^"]*)"/g)) {
      const attribute = match[1];
      const value = match[2];
      if (!USER_VISIBLE_ATTRIBUTES.has(attribute)) continue;
      if (MACHINE_ATTRIBUTES.has(attribute)) continue;
      if (!looksLikeProse(value)) continue;
      violations.push({ file: relative, line: lineNumber, kind: "attribute", excerpt: `${attribute}="${value}"` });
    }
  });

  return violations;
}

/** Every t("<key>") literal in the tree must be a catalog key in BOTH locales. */
function scanKeyUsage(path: string): Array<string> {
  const source = readFileSync(path, "utf8");
  const result: Array<string> = [];
  const relative = path.slice(UI2_ROOT.length + 1);
  for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_.-]+)"/g)) {
    const key = match[1];
    if (!catalogKeys.has(key) || !ruKeys.has(key)) {
      result.push(`${relative}: t("${key}") — key missing from EN or RU catalog`);
    }
  }
  return result;
}

describe("ui2 no hard-coded user-visible strings", () => {
  const files = listSourceFiles(UI2_ROOT).filter((path) => !path.includes("/catalogs/"));

  it("finds the ui2 tree sources (guard self-check)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no hard-coded English strings in ui2 components", () => {
    const violations = files.flatMap((path) => scanFile(path));
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.kind} ${v.excerpt}`),
      "ui2 user-visible strings must come from the catalog (t()), not literals",
    ).toEqual([]);
  });

  it("references only catalog keys that exist in EN and RU", () => {
    const violations = files.flatMap((path) => scanKeyUsage(path));
    expect(violations, "every t() key must exist in both catalogs").toEqual([]);
  });
});
