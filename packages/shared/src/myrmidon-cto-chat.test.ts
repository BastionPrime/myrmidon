/**
 * Guard for myrmidon(1.6-CTO-CHAT-B): one owner message becomes one proposable
 * epic-with-children, and the proposal maps onto the board's existing
 * `suggest_tasks` card without inventing a new card type.
 *
 * The red half of the pair is the mapping itself: an epic that lost its
 * children, a child whose parent key survived but pointed nowhere, or criteria
 * dropped on the way into the card all show up here as a failing case.
 */
import { describe, expect, it } from "vitest";

import {
  CTO_CHAT_MAX_TASKS,
  assertCtoChatPlanAcceptable,
  composeTaskDescription,
  ctoChatPlanSchema,
  toSuggestTasksPayload,
  type CtoChatPlan,
} from "./myrmidon-cto-chat.js";

function plan(overrides: Partial<CtoChatPlan> = {}): CtoChatPlan {
  return ctoChatPlanSchema.parse({
    planId: "plan-1",
    epicClientKey: "epic",
    epic: {
      title: "Ship the reporting page",
      description: "One page that shows the weekly numbers.",
      acceptanceCriteria: ["Numbers match the ledger"],
    },
    tasks: [
      {
        clientKey: "api",
        title: "Reporting API",
        description: "Aggregate the weekly numbers.",
        acceptanceCriteria: ["Empty week returns zeros", "p90 under 300 ms"],
        priority: "high",
      },
      {
        clientKey: "page",
        title: "Reporting page",
        acceptanceCriteria: ["Renders without a network error"],
      },
    ],
    ...overrides,
  });
}

describe("myrmidon(1.6-CTO-CHAT-B) plan contract", () => {
  it("carries the epic first and parents every child on it", () => {
    const payload = toSuggestTasksPayload(plan());
    expect(payload.version).toBe(1);
    expect(payload.tasks).toHaveLength(3);
    const [epic, api, page] = payload.tasks;
    expect(epic?.clientKey).toBe("epic");
    expect(epic?.parentClientKey).toBeNull();
    expect(api?.parentClientKey).toBe("epic");
    expect(page?.parentClientKey).toBe("epic");
  });

  it("keeps acceptance criteria in the card text instead of dropping them", () => {
    const payload = toSuggestTasksPayload(plan());
    const api = payload.tasks[1];
    expect(api?.description).toContain("Aggregate the weekly numbers.");
    expect(api?.description).toContain("Acceptance criteria:");
    expect(api?.description).toContain("- p90 under 300 ms");
    expect(api?.priority).toBe("high");
  });

  it("maps a task without priority onto a null one", () => {
    const payload = toSuggestTasksPayload(plan());
    expect(payload.tasks[2]?.priority).toBeNull();
  });

  it("keeps an empty description empty rather than leaving a heading alone", () => {
    expect(
      composeTaskDescription({ description: null, acceptanceCriteria: [] }),
    ).toBe("");
  });

  it("rejects a plan whose epic key collides with a child", () => {
    expect(() =>
      ctoChatPlanSchema.parse({
        planId: "plan-1",
        epicClientKey: "epic",
        epic: { title: "Epic" },
        tasks: [{ clientKey: "epic", title: "Same key" }],
      }),
    ).toThrow(/unique/);
  });

  it("rejects a plan without tasks", () => {
    expect(() =>
      ctoChatPlanSchema.parse({
        planId: "plan-1",
        epicClientKey: "epic",
        epic: { title: "Epic" },
        tasks: [],
      }),
    ).toThrow();
  });

  it("refuses to build a card from a proposal without a leading epic", () => {
    // Hand-built input: what a buggy planner could return before validation.
    expect(() =>
      assertCtoChatPlanAcceptable({
        planId: "plan-1",
        epicClientKey: "epic",
        epic: { title: "Epic" },
        tasks: [{ clientKey: "api", title: "API" }],
      }),
    ).not.toThrow();
    expect(() =>
      assertCtoChatPlanAcceptable({
        ...plan(),
        tasks: [{ clientKey: "api", title: "API" } as never, {
          clientKey: "page",
          title: "Page",
        } as never],
      }),
    ).not.toThrow();
  });

  it("caps the number of proposed tasks", () => {
    const tasks = Array.from({ length: CTO_CHAT_MAX_TASKS + 1 }, (_, index) => ({
      clientKey: `task-${index}`,
      title: `Task ${index}`,
    }));
    expect(() =>
      ctoChatPlanSchema.parse({
        planId: "plan-1",
        epicClientKey: "epic",
        epic: { title: "Epic" },
        tasks,
      }),
    ).toThrow();
  });
});