// Task PR sync policy.
//
// A task that is delivered by a pull request used to stay "busy" until a person
// noticed that the PR had merged and closed the task by hand. This module is the
// pure half of the sweep that closes that gap: from the task's own work products
// (`type = "pull_request"`, read from the existing work-products surface) and the
// freshly resolved GitHub facts, it decides exactly one of:
//
//   - `settle_done`        — every delivering PR is merged and no post-deploy
//                            gate still holds the task, so the sweep closes it.
//   - `return_to_assignee` — a delivering PR was closed without merging, so the
//                            work is not delivered and the task goes back.
//   - `noop`               — anything else (a PR is still open, a state could
//                            not be resolved, a gate is open, no PR at all).
//
// No database access and no network here: the caller reads the rows and resolves
// the PR state, then packs both into `TaskPrSyncFacts`.

import type { IssueWorkProduct, PullRequestWorkProductMetadata } from "@paperclipai/shared";

/** Effective state of one delivering PR, after the stored row and the resolved facts are merged. */
export type TaskPrSyncPrState =
  | "open"
  | "draft"
  | "merged"
  | "closed"
  | "superseded"
  | "unknown";

export interface TaskPrSyncPrFact {
  workProductId: string;
  /** The state the sweep acts on. `superseded` rows are ignored (a duplicate a newer PR replaced). */
  state: TaskPrSyncPrState;
  repo: string | null;
  number: number | null;
  /** Head (post-merge) sha the resolver reported; the settle-comment dedup marker. `null` when unknown. */
  mergedSha: string | null;
}

export interface TaskPrSyncFacts {
  issueStatus: string;
  /** The task's pull_request work products, archived (superseded) rows included; the policy filters them. */
  prs: TaskPrSyncPrFact[];
  /** An explicit, still-open post-deploy gate holds the task (see the sweep's gate check). */
  openPostDeployGate: boolean;
}

export type TaskPrSyncNoopReason =
  | "terminal_issue"
  | "no_pr_products"
  | "pr_still_open"
  | "pr_state_unknown"
  | "post_deploy_gate_open";

export type TaskPrSyncDecision =
  | { kind: "settle_done"; mergedSha: string | null; prRefs: string[] }
  | { kind: "return_to_assignee"; closedPrRefs: string[] }
  | { kind: "noop"; reason: TaskPrSyncNoopReason };

/** Terminal statuses the sweep must never rewrite. */
const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

const STORED_PR_STATES: ReadonlySet<string> = new Set(["open", "draft", "merged", "closed"]);

function noop(reason: TaskPrSyncNoopReason): TaskPrSyncDecision {
  return { kind: "noop", reason };
}

/** `owner/repo#N`, or `#N` when the repo is not recorded. Human-readable, used in comments and logs. */
export function taskPrReference(fact: Pick<TaskPrSyncPrFact, "repo" | "number">): string {
  if (fact.repo && fact.number !== null) return `${fact.repo}#${fact.number}`;
  if (fact.number !== null) return `#${fact.number}`;
  return fact.repo ?? "PR";
}

/**
 * Merges the stored work-product row with the freshly resolved PR facts into the
 * one state the policy acts on. The resolved facts win; a row the resolver could
 * not reach keeps its stored state, so a GitHub outage never invents a merge.
 */
export function effectivePullRequestState(input: {
  storedStatus: string;
  /** `workProductState` from the resolver, when it resolved one. */
  resolvedState?: "open" | "draft" | "merged" | "closed" | undefined;
}): TaskPrSyncPrState {
  if (input.storedStatus === "archived") return "superseded";
  if (input.resolvedState) return input.resolvedState;
  if (STORED_PR_STATES.has(input.storedStatus)) return input.storedStatus as TaskPrSyncPrState;
  // A row whose stored status is one we do not recognize is treated as unresolved
  // rather than guessed into a settle.
  return "unknown";
}

/** The GitHub PR coordinates recorded on a pull_request work product, if any. */
export function readPullRequestMetadata(
  product: Pick<IssueWorkProduct, "metadata">,
): { repo: string | null; number: number | null } {
  const metadata = (product.metadata ?? {}) as Partial<PullRequestWorkProductMetadata> & Record<string, unknown>;
  const repo = typeof metadata.repo === "string" ? metadata.repo : null;
  const rawNumber = metadata.number;
  const number = typeof rawNumber === "number" && Number.isSafeInteger(rawNumber) && rawNumber > 0 ? rawNumber : null;
  return { repo, number };
}

/** The `metadata.lastMergedSha` marker a previous settle recorded, if any. */
export function readLastMergedSha(
  product: Pick<IssueWorkProduct, "metadata">,
): string | null {
  const metadata = (product.metadata ?? {}) as Record<string, unknown>;
  const sha = metadata.lastMergedSha;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

/**
 * The decision table.
 *
 * Order matters. A PR that is still open means the work is not delivered, so
 * nothing happens whatever the siblings look like. Once every delivering PR has
 * reached a terminal state, at least one of them merged is enough to call the
 * task delivered — an old PR that was closed without merging and replaced by a
 * merged one must settle, not bounce. Only when *none* of them merged is the
 * delivery actually missing and the task goes back to its assignee. Superseded
 * rows are dropped first, so a duplicate the replacement overtook does not keep
 * the task open.
 */
export function decideTaskPrSync(facts: TaskPrSyncFacts): TaskPrSyncDecision {
  if (TERMINAL_ISSUE_STATUSES.has(facts.issueStatus)) return noop("terminal_issue");

  const active = facts.prs.filter((pr) => pr.state !== "superseded");
  if (active.length === 0) return noop("no_pr_products");

  if (active.some((pr) => pr.state === "open" || pr.state === "draft")) return noop("pr_still_open");
  if (active.some((pr) => pr.state === "unknown")) return noop("pr_state_unknown");

  const merged = active.filter((pr) => pr.state === "merged");
  const closed = active.filter((pr) => pr.state === "closed");

  if (merged.length > 0) {
    if (facts.openPostDeployGate) return noop("post_deploy_gate_open");
    // Report the newest merge sha the resolver returned as the representative
    // marker; every merged fact keeps its own sha on the work product.
    const mergedSha = [...merged].reverse().find((pr) => pr.mergedSha)?.mergedSha ?? null;
    return { kind: "settle_done", mergedSha, prRefs: active.map(taskPrReference) };
  }

  if (closed.length > 0) {
    return { kind: "return_to_assignee", closedPrRefs: closed.map(taskPrReference) };
  }

  // Every remaining state is a terminal one we do not act on.
  return noop("no_pr_products");
}

/**
 * True when the task's pull_request work products are all terminal (merged or
 * closed) with at least one merged — i.e. the settle is pending. Reads the
 * stored statuses only; the guard that consumes this must not call GitHub.
 */
export function settlePendingForProducts(
  products: ReadonlyArray<{ type: string; status: string }>,
): boolean {
  const prs = products.filter((product) => product.type === "pull_request" && product.status !== "archived");
  if (prs.length === 0) return false;
  if (prs.some((product) => product.status !== "merged" && product.status !== "closed")) return false;
  return prs.some((product) => product.status === "merged");
}