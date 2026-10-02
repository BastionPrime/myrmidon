import { describe, expect, it } from "vitest";

import {
  createHeuristicJudge,
  createJudge,
  evalsSettingsProblem,
  parseJudgeResponse,
  readEvalsSettings,
  type JudgePort,
} from "./index.js";

// Neutral data only (no real agents, keys or hosts).

const rubric = {
  criteria: [
    { name: "correctness", description: "the answer is correct", points: 3 },
    { name: "clarity", description: "the answer is clear", points: 2 },
  ],
};

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("myrmidon(1.6-EVALS) settings", () => {
  it("is disabled without both the base URL and the key secret name", () => {
    expect(readEvalsSettings({}).enabled).toBe(false);
    expect(evalsSettingsProblem(readEvalsSettings({}))).toContain("MYRMIDON_EVALS_BASE_URL");
    const partial = readEvalsSettings({ MYRMIDON_EVALS_BASE_URL: "http://example.com:4000" });
    expect(partial.enabled).toBe(false);
    expect(evalsSettingsProblem(partial)).toContain("MYRMIDON_EVALS_KEY_SECRET");
  });

  it("defaults to the free DashScope model and a sane timeout", () => {
    const s = readEvalsSettings({ MYRMIDON_EVALS_BASE_URL: "http://example.com:4000", MYRMIDON_EVALS_KEY_SECRET: "gw-key" });
    expect(s.enabled).toBe(true);
    expect(s.model).toBe("qwen-plus-free");
    expect(s.timeoutMs).toBe(120_000);
    expect(s.langfuseExport).toBe(false);
  });

  it("turns the Langfuse export on only with the explicit flag", () => {
    const s = readEvalsSettings({
      MYRMIDON_EVALS_BASE_URL: "http://example.com:4000",
      MYRMIDON_EVALS_KEY_SECRET: "gw-key",
      MYRMIDON_EVALS_LANGFUSE: "true",
    });
    expect(s.langfuseExport).toBe(true);
  });
});

describe("myrmidon(1.6-EVALS) judge response parsing", () => {
  it("parses a clean JSON verdict", () => {
    const { awarded, parseError } = parseJudgeResponse('{"criteria": {"correctness": 3, "clarity": 1}}', rubric);
    expect(parseError).toBe(false);
    expect(awarded).toEqual({ correctness: 3, clarity: 1 });
  });

  it("tolerates a fenced JSON verdict", () => {
    const { awarded, parseError } = parseJudgeResponse('```json\n{"criteria": {"correctness": 2, "clarity": 2}}\n```', rubric);
    expect(parseError).toBe(false);
    expect(awarded).toEqual({ correctness: 2, clarity: 2 });
  });

  it("rejects prose, partial and out-of-range verdicts", () => {
    expect(parseJudgeResponse("the answer looks fine", rubric).parseError).toBe(true);
    expect(parseJudgeResponse('{"criteria": {"correctness": 3}}', rubric).parseError).toBe(true);
    expect(parseJudgeResponse('{"criteria": {"correctness": 9, "clarity": 1}}', rubric).parseError).toBe(true);
    expect(parseJudgeResponse('{"criteria": {"correctness": "3", "clarity": 1}}', rubric).parseError).toBe(true);
    expect(parseJudgeResponse('{"awards": {}}', rubric).parseError).toBe(true);
  });
});

describe("myrmidon(1.6-EVALS) gateway judge", () => {
  it("sends one chat-completions call and returns parsed points", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse('{"criteria": {"correctness": 2, "clarity": 2}}');
    };
    const judge = createJudge({
      fetch: fetchMock,
      apiKey: "test-key",
      baseUrl: "http://example.com:4000",
      model: "test-model",
      timeoutMs: 1000,
    });
    const result = await judge.judgeTask({ taskSlug: "task-a", prompt: "p", answer: "a", rubric, kind: "general" });
    expect(result.parseError).toBe(false);
    expect(result.awarded).toEqual({ correctness: 2, clarity: 2 });
    expect(result.taskSlug).toBe("task-a");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://example.com:4000/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; messages: { role: string }[]; temperature: number };
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("keeps an existing /v1 suffix instead of doubling it", async () => {
    let url = "";
    const fetchMock: typeof fetch = async (u) => {
      url = String(u);
      return jsonResponse('{"criteria": {"correctness": 0, "clarity": 0}}');
    };
    const judge = createJudge({ fetch: fetchMock, apiKey: "k", baseUrl: "http://example.com:4000/v1", model: "m", timeoutMs: 1000 });
    await judge.judgeTask({ taskSlug: "t", prompt: "p", answer: "a", rubric, kind: "general" });
    expect(url).toBe("http://example.com:4000/v1/chat/completions");
  });

  it("flags an unparseable message instead of inventing scores", async () => {
    const judge = createJudge({
      fetch: (async () => jsonResponse("I think the answer is good")) as typeof fetch,
      apiKey: "k",
      baseUrl: "http://example.com:4000",
      model: "m",
      timeoutMs: 1000,
    });
    const result = await judge.judgeTask({ taskSlug: "t", prompt: "p", answer: "a", rubric, kind: "code" });
    expect(result.parseError).toBe(true);
    expect(result.awarded).toEqual({});
  });
});

describe("myrmidon(1.6-EVALS) heuristic judge", () => {
  it("awards from the callback and clamps to the criterion maximum", async () => {
    const judge: JudgePort = createHeuristicJudge(() => 99);
    const result = await judge.judgeTask({ taskSlug: "t", prompt: "p", answer: "a", rubric, kind: "general" });
    expect(result.awarded).toEqual({ correctness: 3, clarity: 2 });
  });

  it("awards zero for a deliberately bad answer", async () => {
    const judge = createHeuristicJudge(() => 0);
    const result = await judge.judgeTask({ taskSlug: "t", prompt: "p", answer: "irrelevant garbage", rubric, kind: "general" });
    expect(result.awarded).toEqual({ correctness: 0, clarity: 0 });
  });
});
