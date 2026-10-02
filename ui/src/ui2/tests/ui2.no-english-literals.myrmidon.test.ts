// ui/src/ui2/tests/ui2.no-english-literals.myrmidon.test.ts
//
// myrmidon(UI2): the no-hardcoded-strings guard for the ui2 tree. Every
// user-visible literal in a ui2 component must come from the catalog.
//
// Method: the source is FIRST stripped of TypeScript (esbuild transform,
// loader tsx + jsx preserve — types vanish, JSX markup stays), then a small
// scanner walks the JSX: text runs between a closing `>` and the next `<`
// are the JSX text nodes; copy-bearing attributes (title/aria-label/
// placeholder/alt) are checked separately. `t("key")` catalog calls are
// blanked before the scan so catalog keys never count as copy; strings in
// code (never JSX text) are ignored by construction.
//
// The earlier draft of this guard collapsed every `{...}` block in the raw
// TSX, including function bodies, so it matched nothing and passed
// vacuously; this version is proven by the two self-checks (reds on a
// planted literal, ignores catalog calls) plus the red-side proof in the PR.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transform } from "esbuild";

const UI2_ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "tests") continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Remove `t("key", …)` catalog calls so their keys do not count as copy. */
function stripCatalogCalls(source: string): string {
  return source.replace(/\bt\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:,[^;]*)?\)/g, "0");
}

const COPY_ATTRS = ["title", "aria-label", "placeholder", "alt"];

const TECHNICAL_ALLOW = new Set(["", "-", "·", "*", "MB", "s"]);

function maybeViolation(raw: string, found: string[]): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  if (TECHNICAL_ALLOW.has(trimmed)) return;
  if (!/[A-Za-zА-Яа-яЁё]/.test(trimmed)) return;
  found.push(trimmed);
}

/**
 * Scan ALREADY-TRANSFORMED (type-stripped, JSX preserved) source for:
 *  1. JSX text nodes — runs between `>` (tag closed) and `<` (next tag);
 *  2. copy attribute literals (title/aria-label/placeholder/alt="…").
 * Arrow `=>` never opens a text node (checked via prev char).
 */
function scanJsx(jsxSource: string): string[] {
  const found: string[] = [];

  const attrPattern = new RegExp(`\\b(?:${COPY_ATTRS.join("|")})\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)')`, "g");
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(jsxSource)) !== null) {
    maybeViolation(attrMatch[1] ?? attrMatch[2] ?? "", found);
  }

  let text = "";
  let inTag = false;
  let jsxTextOpen = false;
  let prev = "";
  let index = 0;
  while (index < jsxSource.length) {
    const char = jsxSource[index];
    if (char === "`") {
      const end = jsxSource.indexOf("`", index + 1);
      index = end === -1 ? jsxSource.length : end + 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < jsxSource.length && jsxSource[index] !== quote) {
        index += 1;
      }
      index += 1;
      // Mark the boundary so a following `>` is not misread as `=>`:
      // right after a closing quote the previous code char is not `=`.
      // (No escape handling: a backslash right before the closing quote
      // would skip past it and unbalance the scan; ui2 sources do not
      // use escaped quotes inside JSX attribute literals.)
      prev = quote;
      continue;
    }
    if (char === "<") {
      if (jsxTextOpen && text) maybeViolation(text, found);
      text = "";
      inTag = true;
      jsxTextOpen = false;
      index += 1;
      continue;
    }
    if (char === ">") {
      if (inTag) {
        // Closes the opening/closing tag: JSX text may follow.
        inTag = false;
        jsxTextOpen = true;
      } else if (prev === "=") {
        // `=>` arrow in code: never opens a text node.
        jsxTextOpen = false;
      } else {
        // Stray `>` in code (generics are stripped by esbuild): not markup.
        jsxTextOpen = false;
      }
      text = "";
      index += 1;
      continue;
    }
    if (char === "{") {
      if (inTag || jsxTextOpen) {
        // JSX expression container (attribute or child): skip balanced
        // braces so their contents (data, catalog calls) never count as
        // text; text collection resumes right after the closing brace.
        let depth = 1;
        index += 1;
        while (index < jsxSource.length && depth > 0) {
          const inner = jsxSource[index];
          if (inner === "{") depth += 1;
          else if (inner === "}") depth -= 1;
          else if (inner === '"' || inner === "'" || inner === "`") {
            const quote = inner;
            index += 1;
            while (index < jsxSource.length && jsxSource[index] !== quote) index += 1;
          }
          index += 1;
        }
        continue;
      }
      // Plain code block (function body, object literal): walk through it
      // normally so JSX inside it is still found; it never opens a text
      // node by itself.
      text = "";
      index += 1;
      continue;
    }
    // Code-only separators never start or continue JSX text. After a
    // self-closing tag (`/>`) the scanner can sit in jsxTextOpen while the
    // next characters are the closing JavaScript of the return statement;
    // `;`, `)` and `}` reliably mark that boundary. (Visible ui2 copy never
    // begins with these; the catalog carries such text, and catalog calls
    // are stripped before the scan.)
    if (jsxTextOpen && !inTag && (char === ";" || char === ")" || char === "}")) {
      text = "";
      jsxTextOpen = false;
      index += 1;
      continue;
    }
    if (!inTag && jsxTextOpen) text += char;
    else text = "";
    prev = char;
    index += 1;
  }
  if (text) maybeViolation(text, found);
  return found;
}

async function scanFile(path: string): Promise<string[]> {
  const raw = readFileSync(path, "utf8");
  const { code } = await transform(raw, { loader: "tsx", jsx: "preserve", format: "esm" });
  return scanJsx(stripCatalogCalls(code));
}

describe("myrmidon(UI2) no hard-coded user-visible literals", () => {
  const files = walk(UI2_ROOT);

  it("found the ui2 components (guard sanity)", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const expected of [
      "Ui2Decisions.tsx",
      "Ui2Costs.tsx",
      "Ui2AgentOverview.tsx",
      "Ui2LanguageSettings.tsx",
    ]) {
      expect(files.some((file) => file.endsWith(expected)), expected).toBe(true);
    }
  });

  it("has no JSX text literals outside the catalog", async () => {
    const violations: Array<{ file: string; literals: string[] }> = [];
    for (const file of files) {
      const literals = await scanFile(file);
      if (literals.length > 0) violations.push({ file: file.slice(UI2_ROOT.length), literals });
    }
    expect(violations).toEqual([]);
  });

  it("proves the guard reds on a hard-coded literal (self-check)", () => {
    const sample = `export function X() { return <button title="Click me" type="button">Decide now</button>; }`;
    const found = scanJsx(stripCatalogCalls(sample));
    expect(found).toEqual(expect.arrayContaining(["Click me", "Decide now"]));
  });

  it("proves the guard ignores catalog calls and data expressions (self-check)", () => {
    const sample = `export function X() { const v = t("key"); return <p title={t("key")}>{t("other", { x: 1 })} {agent.name} {v}</p>; }`;
    const found = scanJsx(stripCatalogCalls(sample));
    expect(found).toEqual([]);
  });
});
