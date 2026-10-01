import { describe, expect, it } from "vitest";

import { CANARY_SMOKE_INPUT, CANARY_SMOKE_SESSION_ID, runCanarySmoke } from "./canary-smoke.js";

// Everything here is placeholder data: fake bot keys, ids and keys.

const API_KEY = "fake-canary-api-key";
const RUN_ID = "run_smoke_1";

type Call = { method: string; path: string; body?: string; headers: Record<string, string> };

/** A transport that records calls and answers from a script of statuses. */
function scriptedTransport(script: {
  createStatus?: number;
  createBody?: string;
  statuses: Array<{ status: number; body: string }>;
}) {
  const calls: Call[] = [];
  let poll = 0;
  const transport = async (opts: { method: string; url: URL; headers: Record<string, string>; body?: string; timeoutMs: number }) => {
    const path = `${opts.url.pathname}${opts.url.search}`;
    calls.push({ method: opts.method, path, body: opts.body, headers: opts.headers });
    if (opts.method === "POST") {
      return { status: script.createStatus ?? 202, body: script.createBody ?? JSON.stringify({ run_id: RUN_ID, replayed: false }) };
    }
    const answer = script.statuses[Math.min(poll, script.statuses.length - 1)];
    poll++;
    return { status: answer.status, body: answer.body };
  };
  return { transport, calls };
}

describe("myrmidon(R5-B) canary smoke", () => {
  it("creates the run with the rollout's idempotency key and a dedicated session", async () => {
    const { transport, calls } = scriptedTransport({
      statuses: [{ status: 200, body: JSON.stringify({ status: "completed" }) }],
    });
    const result = await runCanarySmoke(
      "agent-a",
      "rollout-1",
      { timeoutMs: 10_000, apiKey: API_KEY },
      transport,
      async () => {},
    );
    expect(result).toEqual({ ok: true, runId: RUN_ID, status: "completed" });
    expect(calls).toHaveLength(2);
    const create = calls[0];
    expect(create.method).toBe("POST");
    expect(create.path).toBe("/v1/runs");
    expect(create.headers["Idempotency-Key"]).toBe("canary-rollout-1");
    expect(create.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(create.body!);
    expect(body.session_id).toBe(CANARY_SMOKE_SESSION_ID);
    expect(body.input).toBe(CANARY_SMOKE_INPUT);
    expect(calls[1]).toMatchObject({ method: "GET", path: `/v1/runs/${RUN_ID}` });
  });

  it("polls until a terminal status and reports it", async () => {
    const { transport } = scriptedTransport({
      statuses: [
        { status: 200, body: JSON.stringify({ status: "running" }) },
        { status: 200, body: JSON.stringify({ status: "running" }) },
        { status: 200, body: JSON.stringify({ status: "completed" }) },
      ],
    });
    const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 10_000, apiKey: API_KEY }, transport, async () => {});
    expect(result).toEqual({ ok: true, runId: RUN_ID, status: "completed" });
  });

  it("a failed terminal status is a failed smoke", async () => {
    const { transport } = scriptedTransport({
      statuses: [{ status: 200, body: JSON.stringify({ status: "failed" }) }],
    });
    const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 10_000, apiKey: API_KEY }, transport, async () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("'failed'");
    }
  });

  it("a create refusal is a failed smoke with no run id", async () => {
    const { transport } = scriptedTransport({
      createStatus: 500,
      createBody: "internal",
      statuses: [],
    });
    const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 10_000, apiKey: API_KEY }, transport, async () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.runId).toBeNull();
      expect(result.reason).toContain("HTTP 500");
    }
  });

  it("a create answer without a run_id is a failed smoke", async () => {
    const { transport } = scriptedTransport({
      createStatus: 202,
      createBody: JSON.stringify({ ok: true }),
      statuses: [],
    });
    const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 10_000, apiKey: API_KEY }, transport, async () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("run_id");
    }
  });

  it("a run that never finishes within the budget is a failed smoke", async () => {
    const { transport } = scriptedTransport({
      statuses: [{ status: 200, body: JSON.stringify({ status: "running" }) }],
    });
    const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 0, apiKey: API_KEY }, transport, async () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/did not finish|running/);
    }
  });

  it("a run that disappears (404) is a failed smoke", async () => {
    const { transport } = scriptedTransport({
      statuses: [{ status: 404, body: "not found" }],
    });
    const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 10_000, apiKey: API_KEY }, transport, async () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("disappeared");
    }
  });

  it("the cancel-family terminal statuses are failures, not hangs", async () => {
    for (const status of ["cancelled", "stopped", "interrupted"]) {
      const { transport } = scriptedTransport({
        statuses: [{ status: 200, body: JSON.stringify({ status }) }],
      });
      const result = await runCanarySmoke("agent-a", "rollout-1", { timeoutMs: 10_000, apiKey: API_KEY }, transport, async () => {});
      expect(result.ok).toBe(false);
    }
  });
});
