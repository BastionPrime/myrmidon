import { describe, expect, it } from "vitest";
import {
  blockingWindows,
  decideTick,
  departmentMembers,
  newWindow,
  parseMaintenanceDocument,
  reportsToChain,
  retireWindow,
  windowCoversAgent,
  type MaintenanceScope,
} from "./domain.js";

const now = new Date("2026-09-27T10:00:00.000Z");

function window(scope: MaintenanceScope, companyId: string | null = "company-a", extra = {}) {
  return {
    ...newWindow({
      id: `w-${scope.type}`,
      scope,
      companyId,
      reason: "test",
      drainTimeoutSec: 60,
      onTimeout: "wait",
      startedBy: null,
      now,
    }),
    ...extra,
  };
}

// manager -> lead -> worker; sibling-manager -> sibling-worker
const reportsTo = new Map<string, string | null>([
  ["manager", null],
  ["lead", "manager"],
  ["worker", "lead"],
  ["sibling-manager", null],
  ["sibling-worker", "sibling-manager"],
]);

describe("maintenance scope", () => {
  it("builds the reportsTo chain and cuts cycles", () => {
    expect(reportsToChain("worker", reportsTo)).toEqual(["worker", "lead", "manager"]);
    const cyclic = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(reportsToChain("a", cyclic)).toEqual(["a", "b"]);
  });

  it("lists a department: the manager and every subordinate", () => {
    expect(departmentMembers("manager", reportsTo).sort()).toEqual(["lead", "manager", "worker"]);
    expect(departmentMembers("sibling-worker", reportsTo)).toEqual(["sibling-worker"]);
  });

  it("covers agents by scope", () => {
    const placement = (agentId: string, companyId = "company-a") => ({
      agentId,
      companyId,
      chain: reportsToChain(agentId, reportsTo),
    });
    const dept = window({ type: "department", id: "manager" });
    expect(windowCoversAgent(dept, placement("worker"))).toBe(true);
    expect(windowCoversAgent(dept, placement("manager"))).toBe(true);
    expect(windowCoversAgent(dept, placement("sibling-worker"))).toBe(false);
    expect(windowCoversAgent(dept, placement("worker", "company-b"))).toBe(false);

    const agent = window({ type: "agent", id: "lead" });
    expect(windowCoversAgent(agent, placement("lead"))).toBe(true);
    expect(windowCoversAgent(agent, placement("worker"))).toBe(false);

    const company = window({ type: "company", id: "company-a" });
    expect(windowCoversAgent(company, placement("sibling-worker"))).toBe(true);
    expect(windowCoversAgent(company, placement("worker", "company-b"))).toBe(false);

    expect(windowCoversAgent(window({ type: "instance" }, null), placement("worker", "company-b"))).toBe(true);
  });

  it("does not block admission while a window is leaving", () => {
    const doc = {
      version: 1 as const,
      windows: [window({ type: "agent", id: "a" }), window({ type: "agent", id: "b" }, "company-a", { state: "leaving" })],
      history: [],
    };
    expect(blockingWindows(doc).map((w) => w.scope.id)).toEqual(["a"]);
  });
});

describe("maintenance tick decisions", () => {
  const entering = window({ type: "instance" }, null);
  const later = new Date(now.getTime() + 61_000);

  it("turns on once nothing runs", () => {
    expect(decideTick(entering, [], now)).toEqual({ kind: "mark_on" });
    expect(decideTick(entering, ["run-1"], now)).toEqual({ kind: "none" });
  });

  it("waits past the deadline with onTimeout=wait, reporting the timeout once", () => {
    expect(decideTick(entering, ["run-1"], later)).toEqual({ kind: "mark_timed_out" });
    expect(decideTick({ ...entering, drainTimedOut: true }, ["run-1"], later)).toEqual({ kind: "none" });
  });

  it("interrupts at the deadline with onTimeout=interrupt_and_retry", () => {
    const w = { ...entering, onTimeout: "interrupt_and_retry" as const };
    expect(decideTick(w, ["run-1", "run-2"], later)).toEqual({ kind: "interrupt", runIds: ["run-1", "run-2"] });
  });

  it("finishes leaving windows and leaves on windows alone", () => {
    expect(decideTick({ ...entering, state: "leaving" }, ["run-1"], now)).toEqual({ kind: "finish_leaving" });
    expect(decideTick({ ...entering, state: "on" }, ["run-1"], later)).toEqual({ kind: "none" });
  });
});

describe("maintenance document", () => {
  it("treats malformed storage as no windows", () => {
    expect(parseMaintenanceDocument(undefined).windows).toEqual([]);
    expect(parseMaintenanceDocument({ windows: [{ id: 1 }, "x"] }).windows).toEqual([]);
    expect(parseMaintenanceDocument({ windows: [{ id: "w", scope: { type: "moon" }, state: "on" }] }).windows).toEqual([]);
  });

  it("retires a window into bounded history", () => {
    let doc = { version: 1 as const, windows: [window({ type: "instance" }, null)], history: [] as ReturnType<typeof window>[] };
    for (let i = 0; i < 25; i += 1) doc = { ...doc, history: [...doc.history, window({ type: "agent", id: `a${i}` })] };
    const next = retireWindow(doc, "w-instance", now);
    expect(next.windows).toEqual([]);
    expect(next.history).toHaveLength(20);
    expect(next.history[0]).toMatchObject({ id: "w-instance", exitedAt: now.toISOString() });
  });
});
