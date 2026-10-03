// @vitest-environment jsdom

// myrmidon(AGENTS-TREE): unit tests for the pure tree builder — hierarchy,
// sibling ordering, orphan group, `reportsTo` cycle protection and the
// "every agent appears exactly once" invariant.
import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  buildAgentForest,
  expandedIdsForSearch,
  flattenAgentForest,
  getAgentTreeCollapsedStorageKey,
  readAgentTreeCollapsed,
  writeAgentTreeCollapsed,
} from "./agent-tree";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function ids(nodes: { agent: Agent }[]): string[] {
  return nodes.map((node) => node.agent.id);
}

describe("buildAgentForest", () => {
  it("nests agents under their reportsTo manager", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "ceo", name: "CEO", role: "ceo" }),
      makeAgent({ id: "cto", name: "CTO", role: "cto", reportsTo: "ceo" }),
      makeAgent({ id: "eng", name: "Eng", reportsTo: "cto" }),
    ]);
    expect(ids(forest.roots)).toEqual(["ceo"]);
    expect(ids(forest.roots[0]!.children)).toEqual(["cto"]);
    expect(ids(forest.roots[0]!.children[0]!.children)).toEqual(["eng"]);
    expect(forest.orphans).toHaveLength(0);
  });

  it("sorts leadership roles first, then alphabetically within siblings", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "root", name: "Root" }),
      makeAgent({ id: "zack", name: "Zack", reportsTo: "root" }),
      makeAgent({ id: "cmo", name: "Bob", role: "cmo", reportsTo: "root" }),
      makeAgent({ id: "cto", name: "Carol", role: "cto", reportsTo: "root" }),
      makeAgent({ id: "alice", name: "Alice", reportsTo: "root" }),
    ]);
    expect(ids(forest.roots[0]!.children)).toEqual(["cto", "cmo", "alice", "zack"]);
  });

  it("a manager-less agent with no children is a plain root", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "lone", name: "Lone Wolf" }),
      makeAgent({ id: "root", name: "Root" }),
      makeAgent({ id: "kid", name: "Kid", reportsTo: "root" }),
    ]);
    expect(ids(forest.roots)).toEqual(["lone", "root"]);
    expect(forest.orphans).toHaveLength(0);
  });

  it("agents whose manager id does not exist land in the orphan group", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "ok", name: "OK" }),
      makeAgent({ id: "orphan", name: "Orphan", reportsTo: "missing-manager" }),
    ]);
    expect(ids(forest.roots)).toEqual(["ok"]);
    expect(ids(forest.orphans)).toEqual(["orphan"]);
  });

  it("survives a reportsTo cycle: every agent appears exactly once, no infinite loop", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "a", name: "A", reportsTo: "b" }),
      makeAgent({ id: "b", name: "B", reportsTo: "a" }),
      makeAgent({ id: "c", name: "C", reportsTo: "a" }),
      makeAgent({ id: "root", name: "Root" }),
    ]);
    const flat = flattenAgentForest(forest);
    const flatIds = flat.map((node) => node.agent.id).sort();
    expect(flatIds).toEqual(["a", "b", "c", "root"]);
    // The cycle is cut at exactly one representative; the other member and
    // the third agent keep their manager inside the orphan subtree.
    const orphanRootIds = ids(forest.orphans);
    expect(orphanRootIds).toHaveLength(1);
    const orphanRoot = forest.orphans[0]!;
    expect(["a", "b"]).toContain(orphanRoot.agent.id);
    // c (manager a) and the in-cycle partner are inside the subtree.
    const subtreeIds = flattenAgentForest({ roots: [], orphans: [orphanRoot] }).map((n) => n.agent.id);
    expect(subtreeIds).toContain("c");
    expect(subtreeIds.length).toBe(3);
  });

  it("survives a self-referencing agent", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "self", name: "Self", reportsTo: "self" }),
      makeAgent({ id: "ok", name: "OK" }),
    ]);
    const flat = flattenAgentForest(forest);
    expect(flat.map((node) => node.agent.id).sort()).toEqual(["ok", "self"]);
  });

  it("keeps the child of an orphan with its orphaned parent", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "orphan", name: "Orphan", reportsTo: "missing" }),
      makeAgent({ id: "child", name: "Child", reportsTo: "orphan" }),
    ]);
    expect(ids(forest.orphans)).toEqual(["orphan"]);
    expect(ids(forest.orphans[0]!.children)).toEqual(["child"]);
    expect(flattenAgentForest(forest)).toHaveLength(2);
  });

  it("computes subtree stats: descendantCount, runningCount, hasError", () => {
    const forest = buildAgentForest([
      makeAgent({ id: "root", name: "Root", status: "idle" }),
      makeAgent({ id: "runner", name: "Runner", status: "running", reportsTo: "root" }),
      makeAgent({ id: "broken", name: "Broken", status: "error", reportsTo: "root" }),
      makeAgent({ id: "grandkid", name: "Grandkid", status: "running", reportsTo: "runner" }),
    ]);
    const root = forest.roots[0]!;
    expect(root.descendantCount).toBe(3);
    expect(root.runningCount).toBe(2);
    expect(root.hasError).toBe(true);
    const runner = root.children.find((node) => node.agent.id === "runner")!;
    expect(runner.descendantCount).toBe(1);
    expect(runner.runningCount).toBe(2);
    expect(runner.hasError).toBe(false);
  });

  it("returns every agent exactly once for a real 81-agent company shape", () => {
    // Synthetic replica of the board roster: 5 roots, a 25-child lead,
    // a deep 3-level marketing branch.
    const agents: Agent[] = [];
    for (const root of ["adm", "work", "bbq", "life", "wiki"]) {
      agents.push(makeAgent({ id: root, name: root, role: "cto" }));
    }
    for (let i = 1; i <= 25; i++) {
      agents.push(makeAgent({ id: `eng-${i}`, name: `eng-${i}`, reportsTo: "adm" }));
    }
    for (let i = 1; i <= 11; i++) {
      agents.push(makeAgent({ id: `store-${i}`, name: `store-${i}`, reportsTo: "bbq" }));
    }
    agents.push(makeAgent({ id: "video", name: "video", reportsTo: "bbq" }));
    agents.push(makeAgent({ id: "operator", name: "operator", reportsTo: "video" }));
    agents.push(makeAgent({ id: "photo", name: "photo", reportsTo: "video" }));
    const flat = flattenAgentForest(buildAgentForest(agents));
    expect(flat).toHaveLength(agents.length);
    const unique = new Set(flat.map((node) => node.agent.id));
    expect(unique.size).toBe(agents.length);
    // Criterion: the 81-agent roster reads as a tree — top level ≤ 10 nodes.
    const forest = buildAgentForest(agents);
    expect(forest.roots.length).toBeLessThanOrEqual(10);
  });

  it("handles an empty roster", () => {
    const forest = buildAgentForest([]);
    expect(forest.roots).toHaveLength(0);
    expect(forest.orphans).toHaveLength(0);
  });
});

describe("expandedIdsForSearch", () => {
  const forest = buildAgentForest([
    makeAgent({ id: "root", name: "Root" }),
    makeAgent({ id: "lead", name: "Team Lead", reportsTo: "root" }),
    makeAgent({ id: "eng", name: "Bob Engineer", reportsTo: "lead" }),
  ]);

  it("expands the branch containing a nested match", () => {
    const expanded = expandedIdsForSearch(forest, "engineer");
    expect(expanded.has("root")).toBe(true);
    expect(expanded.has("lead")).toBe(true);
  });

  it("expands nothing for a blank query", () => {
    expect(expandedIdsForSearch(forest, "   ")).toEqual(new Set());
  });

  it("expands nothing when there is no match", () => {
    expect(expandedIdsForSearch(forest, "zzz")).toEqual(new Set());
  });
});

describe("collapsed-state persistence", () => {
  it("round-trips a collapsed set through localStorage", () => {
    localStorage.clear();
    const key = getAgentTreeCollapsedStorageKey("company-1", "user-1");
    expect(key).toBe("paperclip.agentTreeCollapsed:company-1:user-1");
    expect(readAgentTreeCollapsed(key)).toEqual(new Set());
    writeAgentTreeCollapsed(key, ["a", "b"]);
    expect(readAgentTreeCollapsed(key)).toEqual(new Set(["a", "b"]));
    localStorage.clear();
  });

  it("uses the anonymous bucket when the user id is missing", () => {
    expect(getAgentTreeCollapsedStorageKey("company-1", null)).toBe(
      "paperclip.agentTreeCollapsed:company-1:anonymous",
    );
  });

  it("tolerates corrupted storage", () => {
    localStorage.clear();
    localStorage.setItem("k", "{not json");
    expect(readAgentTreeCollapsed("k")).toEqual(new Set());
  });
});
