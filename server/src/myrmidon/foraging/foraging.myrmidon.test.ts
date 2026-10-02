// myrmidon(1.6-FORAGE): the pure rules of the pass — snapshot comparison, the
// budget decision and the finding → candidate rule. No database, no network.
// Neutral data only (agent roles, example.com).
import { describe, expect, it } from "vitest";
import {
  buildSourceResult,
  decideForagingBudget,
  diffSnapshots,
  estimateCostCents,
  isEmptyDiff,
  normalizeSnapshot,
  skillKeyForRole,
  summarizeDiff,
  type ForagingBudget,
} from "./domain.js";

const NO_LIMIT: ForagingBudget = { maxCostCents: 0, enabled: false };
const BUDGET_10: ForagingBudget = { maxCostCents: 10, enabled: true };

describe("myrmidon(1.6-FORAGE) normalizeSnapshot", () => {
  it("trims, drops empty lines, deduplicates and sorts", () => {
    expect(normalizeSnapshot("  beta \n\nalpha\r\nalpha\n   \n")).toEqual(["alpha", "beta"]);
  });

  it("treats a reordered or re-spaced read as the same snapshot", () => {
    expect(normalizeSnapshot("b\n a")).toEqual(normalizeSnapshot("a\nb\n"));
  });

  it("returns an empty list for an empty read", () => {
    expect(normalizeSnapshot("")).toEqual([]);
  });
});

describe("myrmidon(1.6-FORAGE) diffSnapshots", () => {
  it("reports added and removed lines", () => {
    const diff = diffSnapshots(["a", "b", "c"], ["a", "c", "d"]);
    expect(diff).toEqual({ added: ["d"], removed: ["b"] });
  });

  it("reports no change for identical snapshots", () => {
    const diff = diffSnapshots(["a", "b"], ["b", "a"]);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(summarizeDiff(diff)).toBe("no change");
  });

  it("treats the first read (null previous) as no change", () => {
    expect(diffSnapshots(null, ["a", "b"])).toEqual({ added: [], removed: [] });
  });

  it("caps each side of the diff", () => {
    const previous = Array.from({ length: 80 }, (_, index) => `old-${index}`);
    const current = Array.from({ length: 80 }, (_, index) => `new-${index}`);
    const diff = diffSnapshots(previous, current, 10);
    expect(diff.added).toHaveLength(10);
    expect(diff.removed).toHaveLength(10);
  });

  it("summarizes a two-sided change", () => {
    expect(summarizeDiff({ added: ["a", "b"], removed: ["c"] })).toBe("2 added, 1 removed");
  });
});

describe("myrmidon(1.6-FORAGE) skillKeyForRole", () => {
  it("derives a stable key from a role", () => {
    expect(skillKeyForRole("SMM")).toBe("foraged-smm");
    expect(skillKeyForRole("  engineer ")).toBe("foraged-engineer");
    expect(skillKeyForRole("qa/lead")).toBe("foraged-qa-lead");
  });

  it("falls back to general for an empty role", () => {
    expect(skillKeyForRole("   ")).toBe("foraged-general");
  });
});

describe("myrmidon(1.6-FORAGE) estimateCostCents and the budget decision", () => {
  it("prices a read by whole cents, rounded up", () => {
    expect(estimateCostCents(0)).toBe(0);
    expect(estimateCostCents(1024)).toBe(1);
    expect(estimateCostCents(1025)).toBe(2);
  });

  it("allows a read while the spend is below the ceiling", () => {
    const first = decideForagingBudget(BUDGET_10, { spentCents: 0 }, 4);
    expect(first.allowed).toBe(true);
    expect(first.spentCents).toBe(4);
    const second = decideForagingBudget(BUDGET_10, first, 4);
    expect(second.allowed).toBe(true);
    expect(second.spentCents).toBe(8);
  });

  it("stops the pass once the ceiling is reached", () => {
    const decision = decideForagingBudget(BUDGET_10, { spentCents: 10 }, 4);
    expect(decision.allowed).toBe(false);
    expect(decision.spentCents).toBe(10);
  });

  it("has no limit when the budget is off or non-positive", () => {
    expect(decideForagingBudget(NO_LIMIT, { spentCents: 999 }, 4).allowed).toBe(true);
    expect(decideForagingBudget({ maxCostCents: -1, enabled: true }, { spentCents: 999 }, 4).allowed).toBe(true);
  });
});

describe("myrmidon(1.6-FORAGE) buildSourceResult", () => {
  it("records a baseline on the first read and opens no finding", () => {
    const result = buildSourceResult({
      previous: null,
      current: ["a"],
      role: "engineer",
      candidateRef: null,
      portAvailable: true,
    });
    expect(result.outcome).toBe("baseline");
    expect(result.finding).toBeNull();
  });

  it("reports no change when the snapshot is identical", () => {
    const result = buildSourceResult({
      previous: ["a", "b"],
      current: ["b", "a"],
      role: "engineer",
      candidateRef: null,
      portAvailable: true,
    });
    expect(result.outcome).toBe("unchanged");
    expect(result.finding).toBeNull();
  });

  it("keeps the finding unverified while the candidate port is absent", () => {
    const result = buildSourceResult({
      previous: ["a"],
      current: ["a", "b"],
      role: "smm",
      candidateRef: null,
      portAvailable: false,
    });
    expect(result.outcome).toBe("changed");
    expect(result.finding?.status).toBe("unverified");
    expect(result.finding?.summary).toBe("foraged-smm: 1 added");
    expect(result.candidateRef).toBeNull();
  });

  it("marks the finding a candidate when the port returns a reference", () => {
    const result = buildSourceResult({
      previous: ["a"],
      current: ["a", "b"],
      role: "smm",
      candidateRef: "candidate-1",
      portAvailable: true,
    });
    expect(result.finding?.status).toBe("candidate");
    expect(result.candidateRef).toBe("candidate-1");
  });

  it("marks the finding rejected when the port refuses it", () => {
    const result = buildSourceResult({
      previous: ["a"],
      current: ["a", "b"],
      role: "smm",
      candidateRef: null,
      portAvailable: true,
    });
    expect(result.finding?.status).toBe("rejected");
    expect(result.error).not.toBeNull();
  });
});