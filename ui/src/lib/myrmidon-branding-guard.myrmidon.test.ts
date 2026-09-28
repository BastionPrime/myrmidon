// myrmidon(B1a): regression guard for B1a (Myrmidon name and logo in the UI).
// Scans ui/src, plus the handful of packages/shared/src files that ui/src
// imports for user-facing copy (the app-connection catalog and the OAuth/MCP
// rejection-message helpers), for "Paperclip" mentions that should read
// "Myrmidon" instead, and checks that the shipped page/manifest advertise the
// new name. Named references to the real upstream vendor and its actual
// external products/services (Paperclip Cloud, Paperclip Labs, Paperclip EE
// / Enterprise, the vendor's paperclip.ing domain, the untouched
// `paperclip_runner` adapter, PAPERCLIP_* env vars, @paperclipai/* packages,
// the lucide-react "Paperclip" attachment icon, and the MIT attribution line)
// are not renamed — see docs/myrmidon/CONVENTIONS.md #8/#9 and this PR's
// description for why each is excluded.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(UI_SRC, "..", "..");
const APP_DEFINITIONS_DIR = path.join(REPO_ROOT, "packages", "shared", "src", "app-definitions");

// "Paperclip-managed" is deliberately NOT exempted: every instance of that
// exact phrase in ui/src is our own copy (an internal management relationship,
// not the external "Paperclip Cloud"/"Paperclip EE" products below) and is
// renamed to "Myrmidon-managed" throughout this PR — see Connections.tsx.
const WORD_PATTERN = /\bPaperclip\b(?!\s+Cloud|-Cloud|\s+Labs|\s+EE\b|\s+Enterprise|\s+Computer|\s+Runner|\s+runner)/;

const LINE_ALLOW_SUBSTR = [
  "Based on Paperclip", // required MIT attribution, see docs/myrmidon/CONVENTIONS.md #9
  "X-Paperclip",
  "Paperclip Cloud",
  "Paperclip Labs",
  "Paperclip EE",
  "Paperclip Enterprise",
  "Paperclip Computer",
  "Paperclip Runner",
  "Paperclip runner",
  "@paperclipai/",
];

// A raw source line can contain a JS string-escape sequence (\n, \t, \r, \"
// \') immediately followed by "Paperclip" with no real word break between
// them (e.g. `"...\n\nPaperclip is..."`). `\b` doesn't fire there because the
// escape's letter (n/t/r) is itself a word character, so the match is missed
// silently. Replace each such 2-character escape with 2 non-word placeholder
// characters (same length, so match indices below still line up) before
// testing/matching, so a word boundary is always seen at the true text start.
const ESCAPE_SEQUENCE = /\\[nrt"']/g;
function normalizeEscapes(line: string): string {
  return line.replace(ESCAPE_SEQUENCE, "  ");
}

const LUCIDE_IMPORT_LINE = /from\s*["']lucide-react["']/;
const JSX_ICON_USE = /<Paperclip[\s/>]/;
const IMPORT_LIST_BARE = /^\s*Paperclip,?\s*(\/\/.*)?$/;
const BARE_ICON_REF = /(?:^|[^\w])icon:\s*$/i;

// Files that intentionally still say "Paperclip": the unused legacy lockup
// component kept for minimal vendor diff (no longer imported anywhere, see
// Auth.tsx), the office-paperclip-themed loading-spinner whimsy word list /
// animated icon and the login-page ASCII sprite animation (all three need
// real redesign under the ant mark, not a text substitution — see the known
// gap logged in docs/myrmidon/DIVERGENCE.md's "Известные пробелы" table), and
// the `paperclip_runner` adapter's own event labels — that adapter's display
// name ("Paperclip Runner") is a code identifier we don't rename (see the
// `Paperclip Runner` allowlist entry below), so its internal per-event
// fallback strings describing *that adapter's own* events stay consistent
// with it.
const ALLOWLISTED_FILES = new Set(
  [
    "components/PaperclipLockup.tsx",
    "components/AnimatedPaperclipIcon.tsx",
    "components/task-chat/status-whimsy.ts",
    "adapters/paperclip-runner/index.ts",
  ].map((p) => path.join(UI_SRC, p)),
);

// AsciiArtAnimation.tsx has no literal "Paperclip" text (its sprites are pure
// box-drawing/geometry), so it can't be caught by this word-based scan at
// all; it's covered by the same DIVERGENCE.md known-gap entry as the files
// above instead of an allowlist entry here.

function isCommentLine(stripped: string): boolean {
  return stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*");
}

function walk(dir: string, filter: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fp = path.join(dir, entry);
    const stat = statSync(fp);
    if (stat.isDirectory()) {
      walk(fp, filter, out);
    } else if (filter.test(entry)) {
      out.push(fp);
    }
  }
  return out;
}

type Violation = { file: string; line: number; text: string };

/** Scans a fixed list of files (already resolved, absolute paths) for stray "Paperclip" text. */
function findViolationsIn(files: string[], relativeTo: string): Violation[] {
  const violations: Violation[] = [];
  for (const fp of files) {
    if (ALLOWLISTED_FILES.has(fp)) continue;
    const lines = readFileSync(fp, "utf-8").split("\n");
    const fileText = lines.join("\n");
    const lucideIcon = /import\s*\{[^}]*\bPaperclip\b[^}]*\}\s*from\s*["']lucide-react["']/s.test(fileText);
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = normalizeEscapes(rawLine);
      if (!WORD_PATTERN.test(line)) continue;
      const stripped = rawLine.trim();
      if (isCommentLine(stripped)) continue;
      if (LINE_ALLOW_SUBSTR.some((s) => rawLine.includes(s))) continue;
      if (LUCIDE_IMPORT_LINE.test(rawLine) && /\bPaperclip\b/.test(rawLine)) continue;
      if (lucideIcon && IMPORT_LIST_BARE.test(rawLine)) continue;

      // Re-check match by match: a bare `icon: Paperclip` / JSX `<Paperclip`
      // icon reference doesn't count even on a line that also has real text.
      const matches = [...line.matchAll(new RegExp(WORD_PATTERN, "g"))];
      const remaining = matches.filter((m) => {
        const start = m.index ?? 0;
        if (lucideIcon) {
          if (line[Math.max(0, start - 1)] === "<") return false;
          if (JSX_ICON_USE.test(line.slice(Math.max(0, start - 1)))) return false;
          if (BARE_ICON_REF.test(line.slice(Math.max(0, start - 12), start))) return false;
        }
        return true;
      });
      if (remaining.length > 0) {
        violations.push({ file: path.relative(relativeTo, fp), line: i + 1, text: rawLine.trim().slice(0, 160) });
      }
    }
  }
  return violations;
}

function reportOrThrow(violations: Violation[]): void {
  if (violations.length > 0) {
    const report = violations.map((v) => `${v.file}:${v.line}: ${v.text}`).join("\n");
    throw new Error(
      `Found ${violations.length} stray "Paperclip" mention(s) that should read "Myrmidon" ` +
        `(or be added to the allowlist in this test if genuinely external):\n${report}`,
    );
  }
  expect(violations).toEqual([]);
}

describe("myrmidon(B1a): no stray Paperclip branding in ui/src", () => {
  it("has no user-visible 'Paperclip' text outside the documented allowlist", () => {
    const files = walk(UI_SRC, /\.(ts|tsx)$/).filter((fp) => !path.basename(fp).includes(".test."));
    reportOrThrow(findViolationsIn(files, UI_SRC));
  });
});

describe("myrmidon(B1a): no stray Paperclip branding in the shared app-connection catalog", () => {
  it("app-definitions/*.json labels, descriptions and setup guidance say Myrmidon", () => {
    const files = walk(APP_DEFINITIONS_DIR, /\.json$/);
    reportOrThrow(findViolationsIn(files, REPO_ROOT));
  });
});

describe("myrmidon(B1a): no stray Paperclip branding in shared UI-facing message helpers", () => {
  it("oauth-endpoint-url.ts and mcp-remote-headers.ts rejection copy says Myrmidon", () => {
    // These two packages/shared/src modules are imported straight into ui/src
    // (authorizationUrl.ts, generic-mcp-connect.ts) to build on-screen error
    // text; they sit outside ui/src so the walk above never sees them.
    const files = [
      path.join(REPO_ROOT, "packages", "shared", "src", "oauth-endpoint-url.ts"),
      path.join(REPO_ROOT, "packages", "shared", "src", "mcp-remote-headers.ts"),
    ];
    reportOrThrow(findViolationsIn(files, REPO_ROOT));
  });
});

describe("myrmidon(B1a): shipped page and manifest advertise Myrmidon", () => {
  it("index.html title and app name say Myrmidon", () => {
    const html = readFileSync(path.join(REPO_ROOT, "ui", "index.html"), "utf-8");
    expect(html).toMatch(/<title>Myrmidon<\/title>/);
    expect(html).toMatch(/apple-mobile-web-app-title" content="Myrmidon"/);
    expect(html).not.toMatch(/<title>Paperclip<\/title>/);
  });

  it("site.webmanifest name and short_name say Myrmidon", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "ui", "public", "site.webmanifest"), "utf-8"));
    expect(manifest.name).toBe("Myrmidon");
    expect(manifest.short_name).toBe("Myrmidon");
  });
});
