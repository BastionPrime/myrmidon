// myrmidon(B1a): regression guard for B1a (Myrmidon name and logo in the UI).
// Scans ui/src for user-visible "Paperclip" mentions that should read
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

const WORD_PATTERN = /\bPaperclip\b(?!-managed|\s+Cloud|-Cloud|\s+Labs|\s+EE\b|\s+Enterprise|\s+Computer|\s+Runner|\s+runner)/;

const LINE_ALLOW_SUBSTR = [
  "Based on Paperclip", // required MIT attribution, see docs/myrmidon/CONVENTIONS.md #9
  "X-Paperclip",
  "Paperclip Cloud",
  "Paperclip-managed",
  "Paperclip Labs",
  "Paperclip EE",
  "Paperclip Enterprise",
  "Paperclip Computer",
  "Paperclip Runner",
  "Paperclip runner",
  "@paperclipai/",
];

const LUCIDE_IMPORT_LINE = /from\s*["']lucide-react["']/;
const JSX_ICON_USE = /<Paperclip[\s/>]/;
const IMPORT_LIST_BARE = /^\s*Paperclip,?\s*(\/\/.*)?$/;
const BARE_ICON_REF = /(?:^|[^\w])icon:\s*$/i;

// Files that intentionally still say "Paperclip": the unused legacy lockup
// component kept for minimal vendor diff (no longer imported anywhere, see
// Auth.tsx), the office-paperclip-themed loading-spinner whimsy word list /
// animated icon (needs real redesign, not a text substitution), and the
// `paperclip_runner` adapter's own event labels — that adapter's display
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

function isCommentLine(stripped: string): boolean {
  return stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fp = path.join(dir, entry);
    const stat = statSync(fp);
    if (stat.isDirectory()) {
      walk(fp, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) {
      out.push(fp);
    }
  }
  return out;
}

type Violation = { file: string; line: number; text: string };

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const fp of walk(UI_SRC)) {
    if (ALLOWLISTED_FILES.has(fp)) continue;
    const lines = readFileSync(fp, "utf-8").split("\n");
    const fileText = lines.join("\n");
    const lucideIcon = /import\s*\{[^}]*\bPaperclip\b[^}]*\}\s*from\s*["']lucide-react["']/s.test(fileText);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!WORD_PATTERN.test(line)) continue;
      const stripped = line.trim();
      if (isCommentLine(stripped)) continue;
      if (LINE_ALLOW_SUBSTR.some((s) => line.includes(s))) continue;
      if (line.toLowerCase().includes("paperclip.ing")) continue;
      if (LUCIDE_IMPORT_LINE.test(line) && /\bPaperclip\b/.test(line)) continue;
      if (lucideIcon && IMPORT_LIST_BARE.test(line)) continue;

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
        violations.push({ file: path.relative(UI_SRC, fp), line: i + 1, text: line.trim().slice(0, 160) });
      }
    }
  }
  return violations;
}

describe("myrmidon(B1a): no stray Paperclip branding in ui/src", () => {
  it("has no user-visible 'Paperclip' text outside the documented allowlist", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const report = violations.map((v) => `${v.file}:${v.line}: ${v.text}`).join("\n");
      throw new Error(
        `Found ${violations.length} stray "Paperclip" mention(s) that should read "Myrmidon" ` +
          `(or be added to the allowlist in this test if genuinely external):\n${report}`,
      );
    }
    expect(violations).toEqual([]);
  });
});

describe("myrmidon(B1a): shipped page and manifest advertise Myrmidon", () => {
  const repoRoot = path.resolve(UI_SRC, "..", "..");

  it("index.html title and app name say Myrmidon", () => {
    const html = readFileSync(path.join(repoRoot, "ui", "index.html"), "utf-8");
    expect(html).toMatch(/<title>Myrmidon<\/title>/);
    expect(html).toMatch(/apple-mobile-web-app-title" content="Myrmidon"/);
    expect(html).not.toMatch(/<title>Paperclip<\/title>/);
  });

  it("site.webmanifest name and short_name say Myrmidon", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "ui", "public", "site.webmanifest"), "utf-8"));
    expect(manifest.name).toBe("Myrmidon");
    expect(manifest.short_name).toBe("Myrmidon");
  });
});
