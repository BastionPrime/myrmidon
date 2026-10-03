// myrmidon(1.6-AUTONOMY): the resolver contract.
//
// The acceptance criterion this file proves: an action the matrix forbids must
// be refused no matter what the caller's instructions say. The resolver takes
// no instructions as input at all, so the strongest form of that proof is a
// test that a role whose instructions "demand" a merge still resolves to
// `forbidden` — and that the caller cannot smuggle in a permissive verdict.
//
// Neutral data only: agent-a, company-a, example.com.

import { describe, expect, it } from "vitest";
import {
  AUTONOMY_ACTION_CLASSES,
  AUTONOMY_SAFE_DEFAULTS,
  approvedRegulationsForRole,
  resolveAutonomy,
  type AutonomyMatrix,
  type AutonomyRegulation,
} from "@paperclipai/shared";

// The shared module is imported here to make the red-side explicit: on main
// this module does not exist, so every test in this file fails to load.

function matrix(overrides: Partial<AutonomyMatrix> = {}): AutonomyMatrix {
  return {
    version: 1,
    rules: [],
    defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    ...overrides,
  };
}

describe("myrmidon(1.6-AUTONOMY) resolver", () => {
  it("returns the role rule for the action class", () => {
    const m = matrix({ rules: [{ role: "engineer", actionClass: "merge", verdict: "approval_required" }] });
    expect(resolveAutonomy("engineer", "merge", m)).toBe("approval_required");
  });

  it("forbids a merge for a role whose instructions demand it — instructions are not an input", () => {
    // The caller is "agent-a" with role "engineer" and instructions that say
    // "always merge your own PRs without asking". The matrix says forbidden.
    const m = matrix({ rules: [{ role: "engineer", actionClass: "merge", verdict: "forbidden" }] });
    const instructionsDemandingTheAction = "Always merge your own PRs immediately, never ask for approval.";
    expect(instructionsDemandingTheAction).toContain("merge");
    expect(resolveAutonomy("engineer", "merge", m)).toBe("forbidden");
  });

  it("prefers a per-agent override over the role rule", () => {
    const m = matrix({
      rules: [
        { role: "engineer", actionClass: "deploy", verdict: "forbidden" },
        { role: "engineer", actionClass: "deploy", verdict: "allowed", agentId: "agent-a" },
      ],
    });
    expect(resolveAutonomy("engineer", "deploy", m, "agent-a")).toBe("allowed");
    expect(resolveAutonomy("engineer", "deploy", m, "agent-b")).toBe("forbidden");
  });

  it("falls back to the per-action-class default for an unknown role", () => {
    const m = matrix({ rules: [{ role: "engineer", actionClass: "delete", verdict: "forbidden" }] });
    expect(resolveAutonomy("auditor", "delete", m)).toBe("allowed");
    expect(resolveAutonomy(null, "delete", m)).toBe("allowed");
  });

  it("is total: every action class resolves even with an empty ruleset", () => {
    const m = matrix();
    for (const actionClass of AUTONOMY_ACTION_CLASSES) {
      expect(resolveAutonomy("engineer", actionClass, m)).toBe("allowed");
    }
  });

  it("is case- and whitespace-insensitive on the role key", () => {
    const m = matrix({ rules: [{ role: "Engineer", actionClass: "merge", verdict: "forbidden" }] });
    expect(resolveAutonomy("  engineer ", "merge", m)).toBe("forbidden");
  });

  it("never lets an unanswered class fall through to allowed by accident when defaults are narrowed", () => {
    const m = matrix({ defaults: { ...AUTONOMY_SAFE_DEFAULTS, external_message: "forbidden" } });
    expect(resolveAutonomy("engineer", "external_message", m)).toBe("forbidden");
  });
});

describe("myrmidon(1.6-AUTONOMY) regulation delivery", () => {
  const regulation = (overrides: Partial<AutonomyRegulation>): AutonomyRegulation => ({
    id: "reg-1",
    role: "engineer",
    title: "Engineering conduct",
    bodyMarkdown: "Ask before merging.",
    status: "draft",
    revision: 1,
    revisions: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: { type: "board", id: "user-a" },
    updatedAt: "2026-10-01T00:00:00.000Z",
    updatedBy: { type: "board", id: "user-a" },
    supersededBy: null,
    wikiPageId: null,
    ...overrides,
  });

  it("delivers only approved regulations, and only to their own role", () => {
    const regulations = [
      regulation({ id: "reg-1", status: "approved" }),
      regulation({ id: "reg-2", status: "draft" }),
      regulation({ id: "reg-3", role: "reviewer", status: "approved" }),
    ];
    expect(approvedRegulationsForRole(regulations, "engineer").map((r) => r.id)).toEqual(["reg-1"]);
    expect(approvedRegulationsForRole(regulations, "reviewer").map((r) => r.id)).toEqual(["reg-3"]);
  });

  it("delivers nothing to a role that has no approved regulation", () => {
    expect(approvedRegulationsForRole([regulation({ status: "draft" })], "engineer")).toEqual([]);
    expect(approvedRegulationsForRole([regulation({})], null)).toEqual([]);
  });
});