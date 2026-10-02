import { describe, expect, it } from "vitest";
import {
  decideTaskPrSync,
  effectivePullRequestState,
  settlePendingForProducts,
  taskPrReference,
  type TaskPrSyncFacts,
  type TaskPrSyncPrFact,
} from "./policy.js";

function pr(overrides: Partial<TaskPrSyncPrFact> = {}): TaskPrSyncPrFact {
  return {
    workProductId: "wp-1",
    state: "merged",
    repo: "company-a/example.com",
    number: 1,
    mergedSha: "sha-1",
    ...overrides,
  };
}

function facts(overrides: Partial<TaskPrSyncFacts> = {}): TaskPrSyncFacts {
  return {
    issueStatus: "in_progress",
    prs: [pr()],
    openPostDeployGate: false,
    ...overrides,
  };
}

describe("task PR sync policy", () => {
  it("settles the task when every delivering PR is merged", () => {
    const decision = decideTaskPrSync(facts());
    expect(decision).toEqual({ kind: "settle_done", mergedSha: "sha-1", prRefs: ["company-a/example.com#1"] });
  });

  it("settles two merged PRs and reports both references", () => {
    const decision = decideTaskPrSync(
      facts({
        prs: [
          pr({ workProductId: "wp-1", number: 1, mergedSha: "sha-1" }),
          pr({ workProductId: "wp-2", number: 2, mergedSha: "sha-2" }),
        ],
      }),
    );
    expect(decision).toEqual({
      kind: "settle_done",
      mergedSha: "sha-2",
      prRefs: ["company-a/example.com#1", "company-a/example.com#2"],
    });
  });

  it("does nothing while a PR is still open", () => {
    const decision = decideTaskPrSync(facts({ prs: [pr({ state: "open" })] }));
    expect(decision).toEqual({ kind: "noop", reason: "pr_still_open" });
  });

  it("treats a draft PR as still open", () => {
    const decision = decideTaskPrSync(facts({ prs: [pr({ state: "draft" })] }));
    expect(decision).toEqual({ kind: "noop", reason: "pr_still_open" });
  });

  it("returns the task to its assignee when a PR was closed without merging", () => {
    const decision = decideTaskPrSync(facts({ prs: [pr({ state: "closed", mergedSha: null })] }));
    expect(decision).toEqual({ kind: "return_to_assignee", closedPrRefs: ["company-a/example.com#1"] });
  });

  it("settles when one PR merged and a sibling closed without merging", () => {
    // A replacement PR merged after an old one was closed is delivery, not a bounce.
    const decision = decideTaskPrSync(
      facts({
        prs: [
          pr({ workProductId: "wp-1", number: 1 }),
          pr({ workProductId: "wp-2", number: 2, state: "closed", mergedSha: null }),
        ],
      }),
    );
    expect(decision).toEqual({
      kind: "settle_done",
      mergedSha: "sha-1",
      prRefs: ["company-a/example.com#1", "company-a/example.com#2"],
    });
  });

  it("settles a superseded pair: an old closed PR replaced by a merged one", () => {
    const decision = decideTaskPrSync(
      facts({
        prs: [
          pr({ workProductId: "wp-old", number: 5, state: "closed", mergedSha: null }),
          pr({ workProductId: "wp-new", number: 6, mergedSha: "sha-6" }),
        ],
      }),
    );
    expect(decision).toEqual({
      kind: "settle_done",
      mergedSha: "sha-6",
      prRefs: ["company-a/example.com#5", "company-a/example.com#6"],
    });
  });

  it("settles when a superseded duplicate is replaced by a merged PR", () => {
    const decision = decideTaskPrSync(
      facts({
        prs: [
          pr({ workProductId: "wp-old", number: 7, state: "superseded", mergedSha: null }),
          pr({ workProductId: "wp-new", number: 8, mergedSha: "sha-8" }),
        ],
      }),
    );
    expect(decision).toEqual({ kind: "settle_done", mergedSha: "sha-8", prRefs: ["company-a/example.com#8"] });
  });

  it("defers while an explicit post-deploy gate is still open", () => {
    const decision = decideTaskPrSync(facts({ openPostDeployGate: true }));
    expect(decision).toEqual({ kind: "noop", reason: "post_deploy_gate_open" });
  });

  it("does nothing when a PR state could not be resolved", () => {
    const decision = decideTaskPrSync(facts({ prs: [pr({ state: "unknown", mergedSha: null })] }));
    expect(decision).toEqual({ kind: "noop", reason: "pr_state_unknown" });
  });

  it("never rewrites a terminal task", () => {
    expect(decideTaskPrSync(facts({ issueStatus: "done" }))).toEqual({ kind: "noop", reason: "terminal_issue" });
    expect(decideTaskPrSync(facts({ issueStatus: "cancelled" }))).toEqual({
      kind: "noop",
      reason: "terminal_issue",
    });
  });

  it("does nothing when the task has no PR work product", () => {
    expect(decideTaskPrSync(facts({ prs: [] }))).toEqual({ kind: "noop", reason: "no_pr_products" });
    expect(decideTaskPrSync(facts({ prs: [pr({ state: "superseded" })] }))).toEqual({
      kind: "noop",
      reason: "no_pr_products",
    });
  });

  it("merges the stored row and the resolved facts, with the resolved facts winning", () => {
    expect(effectivePullRequestState({ storedStatus: "open", resolvedState: "merged" })).toBe("merged");
    expect(effectivePullRequestState({ storedStatus: "merged" })).toBe("merged");
    expect(effectivePullRequestState({ storedStatus: "archived" })).toBe("superseded");
    expect(effectivePullRequestState({ storedStatus: "ready_for_review" })).toBe("unknown");
  });

  it("formats a PR reference without a repo as #N", () => {
    expect(taskPrReference({ repo: null, number: 12 })).toBe("#12");
    expect(taskPrReference({ repo: "a/b", number: null })).toBe("a/b");
  });

  it("marks a settle pending only when every non-archived PR product is terminal with one merged", () => {
    const merged = { type: "pull_request", status: "merged" } as const;
    const closed = { type: "pull_request", status: "closed" } as const;
    const open = { type: "pull_request", status: "open" } as const;
    const superseded = { type: "pull_request", status: "archived" } as const;
    expect(settlePendingForProducts([merged])).toBe(true);
    expect(settlePendingForProducts([merged, superseded])).toBe(true);
    expect(settlePendingForProducts([merged, closed])).toBe(true);
    expect(settlePendingForProducts([merged, open])).toBe(false);
    expect(settlePendingForProducts([closed])).toBe(false);
    expect(settlePendingForProducts([superseded])).toBe(false);
    expect(settlePendingForProducts([{ type: "document", status: "merged" }])).toBe(false);
  });
});