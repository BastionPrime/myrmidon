// myrmidon(1.6-FORAGE): the pure part of FORAGING.
//
// Three decisions live here, with no database and no Express, so the tests can
// pin them without a container:
//
//  1. Snapshot comparison. A source read is normalized to one line per element
//     (trim, drop empties, deduplicate, sort). The diff against the previous
//     snapshot is an added set and a removed set. The first pass of a source has
//     no previous snapshot: it records the baseline and reports no change — a
//     brand new registry must not open one finding per line.
//
//  2. Cost estimation and the run budget. The sweep counts what it will spend
//     before it spends it: every fetched byte is priced by a fixed rate, and a
//     pass stops as soon as the estimate reaches `maxCostCents`. The stop is a
//     normal outcome (`stopped_by_budget`), not an error: the sources after the
//     stop stay untouched and the next pass continues with them.
//
//  3. The skill-candidate port. A finding becomes a skill candidate only through
//     this port. `createFindingCandidate` takes the diff and the source, and
//     answers a reference or null. The production wiring (SKILL-LIFECYCLE) plugs
//     in behind it; while that module is not merged the tests pass a fake port,
//     and the runtime logs that the port is absent instead of failing a pass.

/** Kinds of source a registry row may have. Kept in sync with the db type. */
export const FORAGING_SOURCE_KINDS = ["url", "feed", "repo", "docs"] as const;
export type ForagingSourceKind = (typeof FORAGING_SOURCE_KINDS)[number];

/** Statuses a finding may have. Kept in sync with the db type. */
export const FORAGING_FINDING_STATUSES = ["unverified", "candidate", "rejected"] as const;
export type ForagingFindingStatus = (typeof FORAGING_FINDING_STATUSES)[number];

/** How many lines of one diff are kept; a huge source must not fill the table. */
export const MAX_DIFF_LINES = 50;

/** The environment variable naming the per-pass cost ceiling, in cents. */
export const FORAGING_BUDGET_CENTS_ENV = "MYRMIDON_FORAGING_BUDGET_CENTS";
/** The environment variable naming the sweep interval, in seconds. */
export const FORAGING_INTERVAL_SEC_ENV = "MYRMIDON_FORAGING_INTERVAL_SEC";
/** The environment variable naming the company secret with the read token. */
export const FORAGING_KEY_SECRET_ENV = "MYRMIDON_FORAGING_KEY_SECRET";

export const DEFAULT_FORAGING_BUDGET_CENTS = 50;
export const DEFAULT_FORAGING_INTERVAL_SEC = 3600;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86_400;
/** Cents per 1000 fetched bytes; a fixed rate keeps the estimate deterministic. */
export const FORAGING_CENTS_PER_KB = 1;
/** The longest answer the sweep accepts from one source, in bytes. */
export const MAX_SOURCE_BYTES = 512 * 1024;

export interface ForagingSnapshotDiff {
  added: string[];
  removed: string[];
}

/**
 * Normalizes a source read into comparable lines: one trimmed line per element,
 * empty lines dropped, duplicates collapsed, order ignored. Two reads that differ
 * only in whitespace, order or repetition are the same snapshot.
 */
export function normalizeSnapshot(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    seen.add(line);
  }
  return [...seen].sort();
}

/**
 * The diff between the previous snapshot and the current read, capped at
 * `MAX_DIFF_LINES` per side. A first read (null previous) is not a change.
 */
export function diffSnapshots(
  previous: readonly string[] | null,
  current: readonly string[],
  maxLines = MAX_DIFF_LINES,
): ForagingSnapshotDiff {
  if (previous === null) return { added: [], removed: [] };
  const before = new Set(previous);
  const after = new Set(current);
  const added = current.filter((line) => !before.has(line)).slice(0, maxLines);
  const removed = previous.filter((line) => !after.has(line)).slice(0, maxLines);
  return { added, removed };
}

/** True when the diff carries no change at either side. */
export function isEmptyDiff(diff: ForagingSnapshotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0;
}

/** A one-line human summary of a diff, for the findings list and the audit row. */
export function summarizeDiff(diff: ForagingSnapshotDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length} added`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
  return parts.length > 0 ? parts.join(", ") : "no change";
}

/** The skill key a finding of a role targets; the lifecycle resolves it later. */
export function skillKeyForRole(role: string): string {
  const slug = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `foraged-${slug || "general"}`;
}

/** The cost of reading `bytes` from a source, in whole cents (rounded up). */
export function estimateCostCents(bytes: number, centsPerKb = FORAGING_CENTS_PER_KB): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil((bytes / 1024) * centsPerKb);
}

export interface ForagingBudget {
  maxCostCents: number;
  /** The ceiling is only a ceiling when a positive number was configured. */
  enabled: boolean;
}

export interface ForagingBudgetState {
  spentCents: number;
}

export interface ForagingBudgetDecision {
  allowed: boolean;
  /** The state after the planned read. */
  spentCents: number;
}

/**
 * Whether one more read may start: it may while the cost already spent is below
 * the ceiling. A `maxCostCents` of zero or less is "off" — the sweep then has no
 * budget limit at all, which is the vendor-free default an operator opts into.
 */
export function decideForagingBudget(
  budget: ForagingBudget,
  state: ForagingBudgetState,
  estimateCents: number,
): ForagingBudgetDecision {
  if (!budget.enabled || budget.maxCostCents <= 0) {
    return { allowed: true, spentCents: state.spentCents + Math.max(0, estimateCents) };
  }
  if (state.spentCents >= budget.maxCostCents) {
    return { allowed: false, spentCents: state.spentCents };
  }
  return { allowed: true, spentCents: state.spentCents + Math.max(0, estimateCents) };
}

/** How a source read ended; the sweep reports the counters to the caller. */
export type ForagingReadOutcome = "changed" | "unchanged" | "baseline" | "failed" | "stopped_by_budget";

export interface ForagingSourceRef {
  id: string;
  companyId: string;
  role: string;
  url: string;
  kind: ForagingSourceKind;
  enabled: boolean;
  lastSnapshot: string[] | null;
}

/** What the port must be told to turn a finding into a skill candidate. */
export interface ForagingCandidateInput {
  companyId: string;
  sourceId: string;
  role: string;
  url: string;
  skillKey: string;
  summary: string;
  diff: ForagingSnapshotDiff;
  detectedAt: Date;
}

/**
 * The seam with SKILL-LIFECYCLE. `createFindingCandidate` answers the reference
 * of the created candidate (a skill or revision id), or null when the lifecycle
 * refused it. `available` lets the runtime skip candidate creation and keep the
 * findings `unverified` while the other module is not merged.
 */
export interface ForagingCandidatePort {
  available: boolean;
  createFindingCandidate(input: ForagingCandidateInput): Promise<string | null>;
}

/** The port used when the skill lifecycle is not wired: it never creates a candidate. */
export const nullForagingCandidatePort: ForagingCandidatePort = {
  available: false,
  async createFindingCandidate() {
    return null;
  },
};

/** What one sweep pass did; the route and the screen read these counters. */
export interface ForagingSweepResult {
  sourcesRead: number;
  findings: number;
  candidates: number;
  spentCents: number;
  stoppedByBudget: boolean;
  errors: number;
}

export interface ForagingSweepSourceResult {
  outcome: ForagingReadOutcome;
  finding: { summary: string; diff: ForagingSnapshotDiff; status: ForagingFindingStatus } | null;
  candidateRef: string | null;
  error: string | null;
}

/**
 * Turns one read into the pass result: the diff decides whether a finding is
 * due, and the port decides whether that finding becomes a candidate. Kept pure
 * so the "a diff produces a finding, and the finding becomes a candidate" rule
 * is tested without a database or a network.
 */
export function buildSourceResult(input: {
  previous: readonly string[] | null;
  current: readonly string[];
  role: string;
  candidateRef: string | null;
  portAvailable: boolean;
}): ForagingSweepSourceResult {
  const diff = diffSnapshots(input.previous, input.current);
  if (input.previous === null) {
    return { outcome: "baseline", finding: null, candidateRef: null, error: null };
  }
  if (isEmptyDiff(diff)) {
    return { outcome: "unchanged", finding: null, candidateRef: null, error: null };
  }
  const summary = `${skillKeyForRole(input.role)}: ${summarizeDiff(diff)}`;
  if (!input.portAvailable) {
    return {
      outcome: "changed",
      finding: { summary, diff, status: "unverified" },
      candidateRef: null,
      error: null,
    };
  }
  const status: ForagingFindingStatus = input.candidateRef ? "candidate" : "rejected";
  return {
    outcome: "changed",
    finding: { summary, diff, status },
    candidateRef: input.candidateRef,
    error: status === "rejected" ? "the skill lifecycle refused the finding" : null,
  };
}