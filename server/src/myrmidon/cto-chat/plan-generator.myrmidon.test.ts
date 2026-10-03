/**
 * Guard for myrmidon(1.6-CTO-CHAT-B): the planner turns one owner message into
 * one proposal and creates nothing on its own.
 *
 * The fake gateway below is the only dependency the module gets: no live
 * network, no keys, no CLI. The red half of the pair is the mapping — the
 * cases where a model answer must become a stable error rather than a
 * half-built card, and the case where a valid answer must reach the card with
 * its children parented on the epic.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CtoChatPlanError,
  ctoChatCompletionUrl,
  extractPlanJson,
  generateCtoChatPlan,
  normalizePlannedAnswer,
} from "./plan-generator.js";
import { DEFAULT_CTO_CHAT_MODEL, type CtoChatSettings } from "./settings.js";

function settings(overrides: Partial<CtoChatSettings> = {}): CtoChatSettings {
  return {
    enabled: true,
    baseUrl: "https://gateway.example.com/v1",
    keySecret: "cto-chat-key",
    model: DEFAULT_CTO_CHAT_MODEL,
    timeoutMs: 5_000,
    maxTasks: 8,
    ...overrides,
  };
}

/** A gateway that answers one canned chat completion. */
function gatewayAnswer(content: string, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, options?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(options?.body ?? "{}")) as unknown,
      headers: (options?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const GOOD_ANSWER = JSON.stringify({
  epic: {
    title: "Add a weekly report page",
    description: "One page that shows the week's numbers.",
    acceptanceCriteria: ["Numbers match the ledger"],
  },
  tasks: [
    {
      clientKey: "api",
      title: "Report API",
      description: "Aggregate the week.",
      acceptanceCriteria: ["Empty week returns zeros"],
      priority: "high",
    },
    { clientKey: "page", title: "Report page", acceptanceCriteria: ["Loads without errors"] },
  ],
});

describe("myrmidon(1.6-CTO-CHAT-B) planner", () => {
  it("targets the OpenAI-compatible path whether or not the address ends in /v1", () => {
    expect(ctoChatCompletionUrl("https://gateway.example.com")).toBe(
      "https://gateway.example.com/v1/chat/completions",
    );
    expect(ctoChatCompletionUrl("https://gateway.example.com/v1/")).toBe(
      "https://gateway.example.com/v1/chat/completions",
    );
  });

  it("sends the owner message to the free model and returns a card-ready proposal", async () => {
    const { fetchImpl, calls } = gatewayAnswer(GOOD_ANSWER);
    const result = await generateCtoChatPlan(
      { text: "Please plan a weekly report page", planId: "plan-1" },
      { fetch: fetchImpl, settings: settings(), apiKey: "test-key" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gateway.example.com/v1/chat/completions");
    const body = calls[0]?.body as { model: string; temperature: number; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe(DEFAULT_CTO_CHAT_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]).toMatchObject({ role: "user", content: "Please plan a weekly report page" });

    expect(result.plan.epic.title).toBe("Add a weekly report page");
    expect(result.plan.epicClientKey).toBe("epic");
    // The epic is first and parentless; every child points at it.
    expect(result.payload.tasks.map((task) => [task.clientKey, task.parentClientKey])).toEqual([
      ["epic", null],
      ["api", "epic"],
      ["page", "epic"],
    ]);
    expect(result.payload.tasks[1]?.description).toContain("Empty week returns zeros");
    expect(result.payload.tasks[1]?.priority).toBe("high");
  });

  it("does not retry a failed gateway call and never echoes the body", async () => {
    const { fetchImpl, calls } = gatewayAnswer("gateway error", { ok: false, status: 502 });
    await expect(
      generateCtoChatPlan({ text: "Plan a report", planId: "plan-1" }, { fetch: fetchImpl, settings: settings(), apiKey: "test-key" }),
    ).rejects.toMatchObject({ code: "backend_failed", status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("refuses an empty or oversized message before calling the model", async () => {
    const { fetchImpl, calls } = gatewayAnswer(GOOD_ANSWER);
    await expect(
      generateCtoChatPlan({ text: "   ", planId: "plan-1" }, { fetch: fetchImpl, settings: settings(), apiKey: "k" }),
    ).rejects.toMatchObject({ code: "empty_message" });
    await expect(
      generateCtoChatPlan({ text: "x".repeat(20_001), planId: "plan-1" }, { fetch: fetchImpl, settings: settings(), apiKey: "k" }),
    ).rejects.toMatchObject({ code: "message_too_long" });
    expect(calls).toHaveLength(0);
  });

  it("refuses when the planner is not configured", async () => {
    const { fetchImpl, calls } = gatewayAnswer(GOOD_ANSWER);
    await expect(
      generateCtoChatPlan(
        { text: "Plan a report", planId: "plan-1" },
        { fetch: fetchImpl, settings: settings({ baseUrl: null, keySecret: null, enabled: false }), apiKey: "k" },
      ),
    ).rejects.toBeInstanceOf(CtoChatPlanError);
    expect(calls).toHaveLength(0);
  });

  it("recovers JSON the model wrapped in a code fence", () => {
    expect(extractPlanJson("```json\n" + GOOD_ANSWER + "\n```")).toMatchObject({
      epic: { title: "Add a weekly report page" },
    });
  });

  it("rejects prose instead of guessing at a plan", () => {
    expect(() => extractPlanJson("Sure! Here is my plan: do the thing.")).toThrow(/no JSON object/);
  });

  it("rejects an answer with no epic or no children", () => {
    expect(() => normalizePlannedAnswer({ tasks: [{ title: "Orphan" }] }, "plan-1", 8)).toThrow(/names no epic/);
    expect(() =>
      normalizePlannedAnswer({ epic: { title: "Epic" }, tasks: [] }, "plan-1", 8),
    ).toThrow(/no child tasks/);
  });

  it("makes colliding model keys unique and fixes the epic key", () => {
    const plan = normalizePlannedAnswer(
      {
        epic: { title: "Epic" },
        tasks: [
          { clientKey: "api", title: "First" },
          { clientKey: "api", title: "Second" },
          { clientKey: "Epic", title: "Third" },
        ],
      },
      "plan-1",
      8,
    );
    const keys = plan.tasks.map((task) => task.clientKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("epic");
  });

  it("caps the answer at the configured number of tasks", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({ clientKey: `t${index}`, title: `Task ${index}` }));
    const plan = normalizePlannedAnswer({ epic: { title: "Epic" }, tasks }, "plan-1", 3);
    expect(plan.tasks).toHaveLength(3);
  });

  it("drops a priority the contract does not know", () => {
    const plan = normalizePlannedAnswer(
      { epic: { title: "Epic" }, tasks: [{ clientKey: "a", title: "A", priority: "unset" }] },
      "plan-1",
      8,
    );
    expect(plan.tasks[0]?.priority ?? null).toBeNull();
  });
});