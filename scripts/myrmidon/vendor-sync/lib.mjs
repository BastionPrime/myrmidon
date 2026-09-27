// Pure helpers for the weekly vendor release sync (R2).
// No I/O here: git access lives in vendor-sync.mjs.

/** Stable vendor release tag: vYYYY.MDD.N, no suffix. */
const STABLE_TAG_RE = /^v(\d{4})\.(\d{3,4})\.(\d+)$/;

export function parseStableTag(tag) {
  const match = STABLE_TAG_RE.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isStableTag(tag) {
  return parseStableTag(tag) !== null;
}

export function compareStableTags(a, b) {
  const pa = parseStableTag(a);
  const pb = parseStableTag(b);
  if (!pa || !pb) throw new Error(`not a stable tag: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Latest stable tag from a list, or null. Canary, beta, rc and other refs are ignored. */
export function pickLatestStable(tags) {
  const stable = tags.filter(isStableTag);
  if (stable.length === 0) return null;
  return stable.sort(compareStableTags).at(-1);
}

/**
 * Decide what to do given the latest vendor tag and the current base.
 * Returns { action: "nothing" | "sync", tag, base, reason }.
 */
export function decideSync({ latestVendorTag, baseTag }) {
  if (!latestVendorTag) {
    return { action: "nothing", tag: null, base: baseTag, reason: "no stable vendor tag found" };
  }
  if (baseTag && compareStableTags(latestVendorTag, baseTag) <= 0) {
    return {
      action: "nothing",
      tag: latestVendorTag,
      base: baseTag,
      reason: `base ${baseTag} is already at or past the latest stable vendor tag ${latestVendorTag}`,
    };
  }
  return { action: "sync", tag: latestVendorTag, base: baseTag, reason: null };
}

/** Vendor PR numbers from commit subjects like "fix: thing (#13654)". */
export function extractPrNumbers(subjects) {
  const numbers = new Set();
  for (const subject of subjects) {
    for (const match of subject.matchAll(/\(#(\d+)\)/g)) numbers.add(Number(match[1]));
  }
  return numbers;
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Parse the divergence registry (docs/myrmidon/DIVERGENCE.md) into rows.
 * Each row: { section, id, cells: {<header>: value}, raw }.
 */
export function parseDivergence(markdown) {
  const rows = [];
  let section = null;
  let headers = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      headers = null;
      continue;
    }
    const cells = splitTableRow(line);
    if (!cells) {
      headers = null;
      continue;
    }
    if (!headers) {
      headers = cells;
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const named = {};
    headers.forEach((header, i) => {
      named[header] = cells[i] ?? "";
    });
    rows.push({ section, id: cells[0], cells: named, raw: line.trim() });
  }
  return rows;
}

/** Vendor file paths named in a registry row ("Файлы вендора" column), without the "+ ours" part. */
export function rowVendorFiles(row) {
  const column = row.cells["Файлы вендора"] ?? "";
  const vendorPart = column.split("+")[0];
  return [...vendorPart.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Does a registry row name the given file (exact path or a directory/glob prefix)? */
export function rowTouchesFile(row, file) {
  return rowVendorFiles(row).some((entry) => {
    const prefix = entry.replace(/\*\*?.*$/, "");
    if (entry === file) return true;
    return prefix.length > 0 && prefix !== entry && file.startsWith(prefix);
  });
}

/**
 * Rows whose removal condition may now hold: the row mentions a vendor PR (#N)
 * that is in the synced range, or it is a `vendor:<sha>` row whose commit is in the range.
 */
export function findPossiblyRemovableRows(rows, { prNumbers, commitShas }) {
  const shas = [...commitShas];
  const result = [];
  for (const row of rows) {
    const reasons = [];
    const text = `${row.cells["Как снимать"] ?? ""} ${row.cells["Причина"] ?? ""}`;
    for (const match of text.matchAll(/#(\d+)/g)) {
      const n = Number(match[1]);
      if (prNumbers.has(n)) reasons.push(`vendor #${n} is in the range`);
    }
    const vendorId = /^vendor:([0-9a-f]{7,40})$/.exec(row.id);
    if (vendorId && shas.some((sha) => sha.startsWith(vendorId[1]))) {
      reasons.push(`commit ${vendorId[1]} is in the range`);
    }
    if (reasons.length > 0) result.push({ row, reasons: [...new Set(reasons)] });
  }
  return result;
}

/** Parse `git diff --name-status` output into [{status, path}]. */
export function parseNameStatus(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0];
      // Renames and copies: status, old path, new path.
      const path = parts.at(-1);
      return { status: status[0], path, from: parts.length > 2 ? parts[1] : null };
    });
}

const DEPENDENCY_FILE_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Dockerfile[^/]*)$/;
const MIGRATION_RE = /^packages\/db\/src\/migrations\/[^/]+\.sql$/;

export function classifyChanges(changes, { markedFiles }) {
  const marked = new Set(markedFiles);
  return {
    workflows: changes.filter((c) => c.path.startsWith(".github/workflows/")),
    migrations: changes.filter((c) => c.status === "A" && MIGRATION_RE.test(c.path)),
    marked: changes.filter((c) => marked.has(c.path) || (c.from && marked.has(c.from))),
    dependencies: changes.filter((c) => DEPENDENCY_FILE_RE.test(c.path)),
  };
}

const STATUS_WORDS = { A: "new", M: "changed", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

function changeLine(change) {
  const word = STATUS_WORDS[change.status] ?? change.status;
  const from = change.from ? ` (from \`${change.from}\`)` : "";
  return `- \`${change.path}\` — ${word}${from}`;
}

function listOrNone(items, render) {
  return items.length === 0 ? "none\n" : `${items.map(render).join("\n")}\n`;
}

/** Build sync-report.md. */
export function buildReport({
  tag,
  base,
  baseBranch,
  branch,
  outcome,
  commits,
  commitLimit = 300,
  conflicts = [],
  conflictRows = [],
  removable = [],
  classified,
}) {
  const lines = [];
  lines.push(`# Vendor sync report: ${tag}`, "");
  lines.push(`- Base: \`${base ?? "unknown"}\` (latest vendor tag reachable from \`${baseBranch}\`)`);
  lines.push(`- New tag: \`${tag}\``);
  lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Outcome: **${outcome}**`);
  lines.push(`- Vendor commits in range: ${commits.length}`, "");

  if (outcome === "conflict") {
    lines.push("## Conflicts", "");
    lines.push("The merge was aborted. Files with conflicts:", "");
    lines.push(listOrNone(conflicts, (file) => `- \`${file}\``));
    lines.push("Registry rows (DIVERGENCE.md) that name these files:", "");
    lines.push(listOrNone(conflictRows, ({ row, file }) => `- \`${file}\`: ${row.section} — ${row.raw}`));
  }

  lines.push("## Registry rows that may now be removable", "");
  lines.push("The vendor PR or commit named in the row is in this range. Check the row's removal condition.", "");
  lines.push(listOrNone(removable, ({ row, reasons }) => `- **${row.id}** (${row.section}): ${reasons.join("; ")}`));

  lines.push("## Workflows (.github/workflows)", "");
  lines.push("New or changed vendor workflows. The maintainer decides whether to disable them.", "");
  lines.push(listOrNone(classified.workflows, changeLine));

  lines.push("## New database migrations", "");
  lines.push(listOrNone(classified.migrations, changeLine));

  lines.push("## Vendor changes in files with our `myrmidon(` markers", "");
  lines.push(listOrNone(classified.marked, changeLine));

  lines.push("## Dependencies and image (package.json, pnpm-lock.yaml, Dockerfile)", "");
  lines.push(listOrNone(classified.dependencies, changeLine));

  lines.push("## Vendor commits", "");
  const shown = commits.slice(0, commitLimit);
  lines.push(listOrNone(shown, (c) => `- \`${c.sha.slice(0, 9)}\` ${c.subject}`));
  if (commits.length > shown.length) {
    lines.push(`…and ${commits.length - shown.length} more (\`git log --oneline ${baseBranch}..${tag}\`).`, "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
