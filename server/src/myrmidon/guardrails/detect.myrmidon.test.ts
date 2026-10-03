// myrmidon(1.6-GRD): pure detector tests — every fixture is neutral
// (example.com, +1-555-01xx, reserved Luhn-valid test numbers, invented
// token shapes). No real credential value appears here.

import { describe, expect, it } from "vitest";
import {
  detectGuardrailHits,
  guardrailSnippet,
  scanGuardrailText,
  summarizeGuardrailHits,
} from "./detect.js";

const FIXED = new Date("2026-01-01T00:00:00.000Z");

describe("myrmidon(1.6-GRD): secret detectors", () => {
  it("detects an openai-shaped project key", () => {
    const text = "deploy with sk-proj-012345678901234567890123 done";
    const report = scanGuardrailText(text);
    expect(report.counts.openai_key).toBe(1);
    expect(report.totalSecrets).toBe(1);
    const hit = report.hits[0]!;
    expect(text.slice(hit.span[0], hit.span[1])).toBe("sk-proj-012345678901234567890123");
  });

  it("detects an anthropic-shaped key", () => {
    const text = "call sk-ant-api03-0123456789012345678901 for the model";
    const report = scanGuardrailText(text);
    expect(report.counts.anthropic_key).toBe(1);
  });

  it("detects github ghp_/gho_ tokens", () => {
    const report = scanGuardrailText("ghp_012345678901234567890123456789 and gho_012345678901234567890123456789");
    expect(report.counts.github_token).toBe(2);
  });

  it("detects an aws access key id", () => {
    const report = scanGuardrailText("AKIA0123456789ABCDEF");
    expect(report.counts.aws_access_key_id).toBe(1);
  });

  it("rejects a short AKIA-like string", () => {
    const report = scanGuardrailText("AKIA0123456789");
    expect(report.totalSecrets).toBe(0);
  });

  it("detects a slack bot token", () => {
    // built from parts so no real-shape token literal sits in the source
    const token = ["xoxb", "0123456789", "0123456789", "0123456789"].join("-");
    const report = scanGuardrailText(token);
    expect(report.counts.slack_bot_token).toBe(1);
  });

  it("detects a bearer jwt with three segments", () => {
    // built from parts so no real-shape JWT literal sits in the source
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJhZ2VudC1hIn0",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const text = `Authorization: Bearer ${jwt}`;
    const report = scanGuardrailText(text);
    expect(report.counts.bearer_jwt).toBe(1);
    // the jwt must not also count as phones or a card
    expect(report.totalPii).toBe(0);
  });

  it("detects a pcp_-prefixed token", () => {
    const report = scanGuardrailText("key pcp_0123456789abcdef0123 end");
    expect(report.counts.pcp_token).toBe(1);
  });

  it("does not flag ordinary prose", () => {
    const report = scanGuardrailText("agent-a finished the sweep and wrote the report to the workspace.");
    expect(report.total).toBe(0);
  });
});

describe("myrmidon(1.6-GRD): pii detectors", () => {
  it("detects an e-mail", () => {
    const report = scanGuardrailText("write to agent-a@example.com please");
    expect(report.counts.email).toBe(1);
    expect(report.hits[0]!.kind).toBe("pii");
  });

  it("detects a neutral phone number", () => {
    const report = scanGuardrailText("call +1-555-0100 now");
    expect(report.counts.phone).toBeGreaterThanOrEqual(1);
  });

  it("does not count short digit runs as phones", () => {
    const report = scanGuardrailText("issues 123 and 4567 are open");
    expect(report.counts.phone).toBeUndefined();
  });

  it("detects a luhn-valid card number and rejects an invalid one", () => {
    // 4111111111111111 is the reserved Visa test number; 4111111111111112 fails Luhn.
    const good = scanGuardrailText("card 4111111111111111 charged");
    expect(good.counts.payment_card).toBe(1);
    const bad = scanGuardrailText("card 4111111111111112 charged");
    expect(bad.counts.payment_card).toBeUndefined();
  });

  it("detects a checksum-valid SNILS and rejects an invalid control", () => {
    // 112-233-445 05 is checksum-valid; the same digits with control 96 are not.
    const good = scanGuardrailText("snils 112-233-445 05 on file");
    expect(good.counts.snils).toBe(1);
    const bad = scanGuardrailText("snils 112-233-445 96 on file");
    expect(bad.counts.snils).toBeUndefined();
  });

  it("detects a checksum-valid INN 10 and rejects an invalid one", () => {
    // 7830002293 is the canonical valid INN-10; 7830002294 is not.
    const good = scanGuardrailText("inn 7830002293 registered");
    expect(good.counts.inn).toBe(1);
    const bad = scanGuardrailText("inn 7830002294 registered");
    expect(bad.counts.inn).toBeUndefined();
  });

  it("detects a checksum-valid INN 12 and rejects an invalid one", () => {
    // 500100732259 is a canonical valid INN-12.
    const good = scanGuardrailText("inn 500100732259 registered");
    expect(good.counts.inn).toBe(1);
    const bad = scanGuardrailText("inn 500100732258 registered");
    expect(bad.counts.inn).toBeUndefined();
  });

  it("does not count an ordinary 10-digit run as INN", () => {
    const report = scanGuardrailText("order 0123456789 shipped");
    expect(report.counts.inn).toBeUndefined();
  });
});

describe("myrmidon(1.6-GRD): aggregation and overlap", () => {
  it("builds the aggregate report", () => {
    const report = scanGuardrailText("agent-a@example.com and sk-proj-01234567890123456789012");
    expect(report.total).toBe(2);
    expect(report.totalSecrets).toBe(1);
    expect(report.totalPii).toBe(1);
    expect(report.counts.email).toBe(1);
    expect(report.counts.openai_key).toBe(1);
  });

  it("lets a secret win over an overlapping pii shape", () => {
    const text = "sk-proj-01234567890123456789012";
    const hits = detectGuardrailHits(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("secret");
  });

  it("respects the category filter", () => {
    const text = "agent-a@example.com and ghp_0123456789012345678901";
    const secretsOnly = detectGuardrailHits(text, ["secret"]);
    expect(secretsOnly.every((hit) => hit.kind === "secret")).toBe(true);
    expect(secretsOnly.length).toBe(1);
    const piiOnly = detectGuardrailHits(text, ["pii"]);
    expect(piiOnly.every((hit) => hit.kind === "pii")).toBe(true);
  });

  it("returns an empty report for empty or non-string input", () => {
    expect(scanGuardrailText("").total).toBe(0);
    expect(scanGuardrailText(undefined as unknown as string).total).toBe(0);
  });

  it("summarizes an explicit hit list", () => {
    const report = summarizeGuardrailHits([]);
    expect(report).toEqual({ hits: [], counts: {}, totalSecrets: 0, totalPii: 0, total: 0 });
  });
});

describe("myrmidon(1.6-GRD): snippet extraction", () => {
  it("cuts a bounded snippet around the span from masked text", () => {
    const masked = "contact agent-a at masked value [secret:token] please";
    const span: [number, number] = [30, 48];
    const snippet = guardrailSnippet(masked, span);
    expect(snippet).toBeTruthy();
    expect(snippet!.length).toBeLessThanOrEqual(96);
    expect(snippet).toContain("[secret:token]");
  });

  it("truncates very long snippets", () => {
    const masked = "x".repeat(500);
    const snippet = guardrailSnippet(masked, [100, 400], 48);
    expect(snippet!.length).toBeLessThanOrEqual(48);
  });

  it("returns null for empty masked text", () => {
    expect(guardrailSnippet("", [0, 1])).toBeNull();
  });
});

describe("myrmidon(1.6-GRD): determinism", () => {
  it("is stable across repeated scans of the same text", () => {
    const text = "write agent-a@example.com or call +1-555-0100, inn 7830002293";
    const first = scanGuardrailText(text);
    const second = scanGuardrailText(text);
    expect(first).toEqual(second);
  });

  it("is independent of a fixed clock value", () => {
    expect(FIXED.getUTCFullYear()).toBe(2026);
  });
});
