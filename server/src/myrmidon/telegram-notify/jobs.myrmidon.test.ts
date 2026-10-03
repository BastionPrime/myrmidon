import { describe, expect, it, vi } from "vitest";
// myrmidon(OPE-3789-B): pure-logic tests of the digest/escalation jobs.
// The DB-backed end-to-end path (real outbox rows, fake Telegram transport)
// lives in jobs.integration.myrmidon.test.ts.
import {
  buildDigestSections,
  digestAlreadySent,
  parseDigestTime,
  renderDigestBody,
} from "./jobs.js";
import { defaultTelegramNotifySettings } from "./settings.js";

const snapshot = (items: Array<{ sourceKind: string; title: string | null; issueId: string | null }>) => ({
  companyId: "company-a",
  generatedAt: "2026-10-03T00:00:00.000Z",
  items: items.map((item) => ({ ...item, severity: "medium", queues: [] })),
});

const ALL_SECTIONS = ["done", "blocked", "needs_decision", "spend"] as const;

describe("parseDigestTime", () => {
  it("accepts the contract default", () => {
    expect(parseDigestTime("09:00")).toEqual({ hours: 9, minutes: 0 });
  });
  it("rejects malformed times", () => {
    expect(parseDigestTime("9:00")).toBeNull();
    expect(parseDigestTime("24:00")).toBeNull();
    expect(parseDigestTime("09:60")).toBeNull();
    expect(parseDigestTime("")).toBeNull();
    expect(parseDigestTime("whenever")).toBeNull();
  });
});

describe("digestAlreadySent", () => {
  it("matches the same UTC day only", () => {
    expect(digestAlreadySent({ lastDigestDate: "2026-10-03" }, "2026-10-03")).toBe(true);
    expect(digestAlreadySent({ lastDigestDate: "2026-10-03" }, "2026-10-04")).toBe(false);
    expect(digestAlreadySent({ lastDigestDate: null }, "2026-10-03")).toBe(false);
  });
});

describe("buildDigestSections + renderDigestBody", () => {
  it("maps feed rows into the fixed sections", () => {
    const views = buildDigestSections({
      snapshot: snapshot([
        { sourceKind: "decision", title: "Choose the vendor", issueId: null },
        { sourceKind: "issue_thread_interaction", title: "Confirm the plan", issueId: null },
        { sourceKind: "blocker_attention", title: "Waiting on a review", issueId: null },
        { sourceKind: "failed_run", title: "agent-a run failed", issueId: null },
        { sourceKind: "budget_alert", title: "company budget warning", issueId: null },
        { sourceKind: "stack_update", title: "New upstream release", issueId: null },
      ]),
      completedIssues: [{ identifier: "ABC-1", title: "Fix the flaky test" }],
      budgetLines: [],
      sections: ALL_SECTIONS,
    });
    const bySection = Object.fromEntries(views.map((view) => [view.section, view.lines]));
    expect(bySection.done).toEqual(["- ABC-1 Fix the flaky test"]);
    expect(bySection.blocked).toHaveLength(2);
    expect(bySection.needs_decision).toHaveLength(3); // decision + interaction + budget alert
    expect(bySection.spend).toEqual(["- company budget warning"]);
    // Unknown source kinds contribute nothing.
    expect(views.flatMap((view) => view.lines)).not.toContain("- New upstream release");
  });

  it("renders sections in the fixed order and keeps empty sections as None", () => {
    const body = renderDigestBody({
      date: "2026-10-03",
      sections: buildDigestSections({
        snapshot: snapshot([]),
        completedIssues: [],
        budgetLines: [],
        sections: ALL_SECTIONS,
      }),
    });
    const order = body
      .split("\n\n")
      .map((part) => part.split("\n")[0])
      .slice(1);
    expect(order).toEqual(["Completed", "Blocked", "Needs your decision", "Budget"]);
    expect(body).toContain("Daily digest for 2026-10-03");
    expect((body.match(/None/g) ?? []).length).toBe(4);
  });

  it("respects the configured section subset", () => {
    const views = buildDigestSections({
      snapshot: snapshot([
        { sourceKind: "decision", title: "Choose the vendor", issueId: null },
        { sourceKind: "blocker_attention", title: "Waiting on a review", issueId: null },
      ]),
      completedIssues: [{ identifier: "ABC-1", title: "Fix the flaky test" }],
      budgetLines: [],
      sections: ["done", "spend"],
    });
    expect(views.map((view) => view.section)).toEqual(["done", "spend"]);
    expect(views[0].lines).toEqual(["- ABC-1 Fix the flaky test"]);
    expect(views[1].lines).toEqual([]);
  });
});

describe("default settings (release criterion: everything off)", () => {
  it("defaults keep digest and escalations off", () => {
    const settings = defaultTelegramNotifySettings();
    expect(settings.digest.enabled).toBe(false);
    expect(settings.escalations.enabled).toBe(false);
    expect(settings.escalations.channel).toBe("none");
    expect(settings.errors.enabled).toBe(false);
    expect(settings.inbound.enabled).toBe(false);
    expect(settings.proactivity.mode).toBe("only_on_owner_request");
  });
});
