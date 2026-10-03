// server/src/myrmidon/autonomy/caste-roles.myrmidon.test.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES B): the autonomy matrix regression tests for
// caste (non-standard) roles.
//
// The ticket's criterion: "moving an agent to a caste must not change any
// verdict" — the schema does not change, the caste key is the role string,
// and the matrix keeps resolving exactly as before. Pinned here:
//
//   1. rows keyed by caste keys resolve by the same specificity order
//      (agent > role > default) as the built-in roles;
//   2. translating an agent from a built-in role to a caste role leaves the
//      verdicts identical (the "rights did not shrink" acceptance);
//   3. a caste key unknown to the matrix falls to the default, never to an
//      accident.
//
// Neutral data only: agent-a, company-a.

import { describe, expect, it } from "vitest";
import {
  AUTONOMY_ACTION_CLASSES,
  AUTONOMY_SAFE_DEFAULTS,
  resolveAutonomy,
  type AutonomyMatrix,
} from "@paperclipai/shared";

function matrix(overrides: Partial<AutonomyMatrix> = {}): AutonomyMatrix {
  return {
    version: 1,
    rules: [],
    defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    ...overrides,
  };
}

describe("myrmidon(1.6.1 CUSTOM-CASTES B) autonomy matrix with caste roles", () => {
  it("resolves a caste-key row by the same agent > role > default order", () => {
    const m = matrix({
      rules: [
        { role: "reviewer", actionClass: "merge", verdict: "approval_required" },
        { role: "reviewer", actionClass: "deploy", verdict: "forbidden" },
        { role: "reviewer", actionClass: "deploy", verdict: "allowed", agentId: "agent-a" },
      ],
    });
    // role row
    expect(resolveAutonomy("reviewer", "merge", m)).toBe("approval_required");
    // agent override wins over the role row
    expect(resolveAutonomy("reviewer", "deploy", m, "agent-a")).toBe("allowed");
    expect(resolveAutonomy("reviewer", "deploy", m, "agent-b")).toBe("forbidden");
  });

  it("moving an agent from a built-in role to a caste role changes no verdict (rights did not shrink)", () => {
    // A matrix that rules on the built-in role the agent is leaving.
    const m = matrix({
      rules: [
        { role: "engineer", actionClass: "merge", verdict: "approval_required" },
        { role: "engineer", actionClass: "deploy", verdict: "allowed" },
        { role: "reviewer", actionClass: "merge", verdict: "approval_required" },
        { role: "reviewer", actionClass: "deploy", verdict: "allowed" },
      ],
    });
    const before = Object.fromEntries(
      AUTONOMY_ACTION_CLASSES.map((actionClass) => [
        actionClass,
        resolveAutonomy("engineer", actionClass, m, "agent-a"),
      ]),
    );
    const after = Object.fromEntries(
      AUTONOMY_ACTION_CLASSES.map((actionClass) => [
        actionClass,
        resolveAutonomy("reviewer", actionClass, m, "agent-a"),
      ]),
    );
    // The caste row mirrors the built-in row (the directory names the caste,
    // the matrix keeps its rules per key), so every verdict is identical.
    expect(after).toEqual(before);
    // And an agent-level override survives the translation untouched.
    const withOverride = matrix({
      rules: [
        ...m.rules,
        { role: "engineer", actionClass: "delete", verdict: "allowed", agentId: "agent-a" },
      ],
    });
    expect(resolveAutonomy("engineer", "delete", withOverride, "agent-a")).toBe("allowed");
    expect(resolveAutonomy("reviewer", "delete", withOverride, "agent-a")).toBe("allowed");
  });

  it("a caste key the matrix has no row for falls to the default (total resolver)", () => {
    const m = matrix({
      rules: [{ role: "engineer", actionClass: "merge", verdict: "forbidden" }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS, delete: "forbidden" },
    });
    // The engineer row does not leak onto the unknown caste key.
    expect(resolveAutonomy("brand-new-caste", "merge", m)).toBe("allowed");
    // The narrowed default applies.
    expect(resolveAutonomy("brand-new-caste", "delete", m)).toBe("forbidden");
    // No role at all is the same path.
    expect(resolveAutonomy(null, "delete", m)).toBe("forbidden");
  });

  it("case- and whitespace-insensitivity holds for caste keys exactly as for built-in roles", () => {
    const m = matrix({ rules: [{ role: "focused-qa", actionClass: "merge", verdict: "forbidden" }] });
    expect(resolveAutonomy("  Focused-QA ", "merge", m)).toBe("forbidden");
    // A different key is NOT the same caste: it falls to the default.
    expect(resolveAutonomy("focusedqa", "merge", m)).toBe("allowed");
  });
});