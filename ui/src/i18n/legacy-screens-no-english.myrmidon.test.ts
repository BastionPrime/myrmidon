// myrmidon(UI-RU): static guard — the core legacy screens carry no literal
// English JSX text or title/label/placeholder attributes; visible strings run
// through the fork i18n catalog. Codes, identifiers, error messages surfaced
// from the server and data-testid values stay out of scope.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCREENS = [
  "pages/Issues.tsx",
  "components/IssuesList.tsx",
  "components/IssueColumns.tsx",
  "pages/Agents.tsx",
  "pages/Inbox.tsx",
  "pages/IssueDetail.tsx",
  "pages/Quality.tsx",
  "pages/Quality.production.tsx",
  "pages/Foraging.tsx",
  "pages/SwarmSupervisor.tsx",
  "pages/SwarmSupervisor.production.tsx",
  "pages/SkillLifecycle.tsx",
  "components/myrmidon/skill-lifecycle/SkillLifecyclePanel.tsx",
  "components/access/CompanySettingsNav.tsx",
];

// Words that may appear as literal JSX text or attribute values without
// breaking the RU screen: machine tokens and vendor-scope words.
const ALLOWED_TEXT = /^(—|-|…|\+|%|\d|\$|\{)/;

describe("legacy screens carry no English literals", () => {
  for (const rel of SCREENS) {
    it(`${rel} has no literal English UI text`, () => {
      const path = join(UI_ROOT, rel);
      const source = readFileSync(path, "utf8");
      const lines = source.split("\n");
      const offenders: string[] = [];

      for (const [index, line] of lines.entries()) {
        // strip comments so myrmidon markers do not count
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*(import|export (type|interface|const|function|type)|\*|\/\*)/.test(code.trim()) && !/<\w/.test(code)) continue;

        // JSX text children like >Some English words<
        for (const match of code.matchAll(/>([^<>{}"'\n]{2,80})</g)) {
          const text = match[1].trim();
          if (!text) continue;
          if (ALLOWED_TEXT.test(text)) continue;
          if (!/[A-Za-z]{2}/.test(text)) continue;
          // single-word camelCase/identifier-looking tokens are code, not UI
          if (/^[a-z][A-Za-z0-9_]*$/.test(text)) continue;
          // code fragments between angle brackets: comparisons, type
          // parameters and call arguments, not JSX text
          if (/[()=?.]/.test(text)) continue;
          // TS type tokens that appear between angle brackets
          if (/^(Promise|Set|Map|Array|Partial|Pick|React|ReactNode|unknown|void)$/.test(text)) continue;
          // type-parameter fragments: commas, intersections, generics
          if (/[,]|&|\bRecord\b/.test(text)) continue;
          offenders.push(`line ${index + 1}: text "${text}"`);
        }
        // user-visible attributes with literal values
        for (const match of code.matchAll(/\b(message|title|placeholder|intro|aria-label|label|description|emptyMessage)="([A-Z][^"]{3,80})"/g)) {
          offenders.push(`line ${index + 1}: attr ${match[1]}="${match[2]}"`);
        }
      }

      expect(offenders, `expected no literal English UI text in ${rel}`).toEqual([]);
    });
  }
});
