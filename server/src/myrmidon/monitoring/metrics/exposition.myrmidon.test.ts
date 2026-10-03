// myrmidon(1.7-METRICS): the exposition-format contract. Every family the
// ticket names must be present with exactly one HELP and one TYPE line, the
// samples must be parseable values, and the text must end with a newline.

import { describe, expect, it } from "vitest";
import {
  METRIC_FAMILIES,
  escapeLabelValue,
  formatSampleValue,
  percentile,
  renderMetricsText,
  type MetricsSnapshot,
} from "./metrics.js";

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    runsActive: 2,
    runsQueued: 5,
    runsFailedTotal: 7,
    runsFailedWindow: 1,
    runDurationSecondsP50: 42.5,
    runDurationSecondsP95: 130.25,
    roleQueueTasks: [
      { role: "engineer", status: "todo", count: 3 },
      { role: "engineer", status: "in_progress", count: 1 },
      { role: "reviewer", status: "in_review", count: 2 },
    ],
    swarmClaimsActive: 4,
    swarmClaimsTotal: 12,
    agentErrorSignals: 1,
    llmCostCentsWindow: 1234,
    scrapeErrors: 0,
    collectedAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("prometheus exposition format", () => {
  it("renders every family the ticket names", () => {
    const text = renderMetricsText(snapshot());
    for (const family of METRIC_FAMILIES) {
      expect(text, `family ${family} must appear`).toContain(family);
    }
  });

  it("renders exactly one HELP and one TYPE line per family", () => {
    const text = renderMetricsText(snapshot());
    const lines = text.split("\n");
    for (const family of METRIC_FAMILIES) {
      const helpLines = lines.filter((line) => line.startsWith(`# HELP ${family} `));
      const typeLines = lines.filter((line) => line.startsWith(`# TYPE ${family} `));
      expect(helpLines, `${family} HELP`).toHaveLength(1);
      expect(typeLines, `${family} TYPE`).toHaveLength(1);
    }
  });

  it("declares the expected TYPE per family", () => {
    const text = renderMetricsText(snapshot());
    expect(text).toContain("# TYPE myrmidon_runs_active gauge");
    expect(text).toContain("# TYPE myrmidon_runs_queued gauge");
    expect(text).toContain("# TYPE myrmidon_runs_failed_total gauge");
    expect(text).toContain("# TYPE myrmidon_runs_failed_window gauge");
    expect(text).toContain("# TYPE myrmidon_run_duration_seconds summary");
    expect(text).toContain("# TYPE myrmidon_role_queue_tasks gauge");
    expect(text).toContain("# TYPE myrmidon_swarm_claims_active gauge");
    expect(text).toContain("# TYPE myrmidon_swarm_claims_total counter");
    expect(text).toContain("# TYPE myrmidon_agent_error_signals gauge");
    expect(text).toContain("# TYPE myrmidon_llm_cost_cents_total counter");
    expect(text).toContain("# TYPE myrmidon_scrape_errors gauge");
  });

  it("renders one sample line per family and per role/status pair", () => {
    const text = renderMetricsText(snapshot());
    const sampleLines = text.split("\n").filter((line) => line.startsWith("myrmidon_"));
    // 9 single-sample families + 2 quantile samples + 3 role pairs = 14.
    expect(sampleLines).toHaveLength(14);
    expect(text).toContain('myrmidon_role_queue_tasks{role="engineer",status="todo"} 3');
    expect(text).toContain('myrmidon_role_queue_tasks{role="reviewer",status="in_review"} 2');
  });

  it("renders run duration quantiles with the quantile label", () => {
    const text = renderMetricsText(snapshot());
    expect(text).toContain('myrmidon_run_duration_seconds{quantile="0.5"} 42.5');
    expect(text).toContain('myrmidon_run_duration_seconds{quantile="0.95"} 130.25');
  });

  it("omits quantile samples when there is no finished run in the window", () => {
    const text = renderMetricsText(
      snapshot({ runDurationSecondsP50: null, runDurationSecondsP95: null }),
    );
    expect(text).toContain("# TYPE myrmidon_run_duration_seconds summary");
    expect(text).not.toContain('myrmidon_run_duration_seconds{quantile=');
  });

  it("ends with a newline and separates families with blank lines", () => {
    const text = renderMetricsText(snapshot());
    expect(text.endsWith("\n")).toBe(true);
    const body = text.slice(0, -1);
    for (const block of body.split("\n\n")) {
      // Every block starts with its HELP line (no leading blank lines).
      expect(block.startsWith("# HELP myrmidon_")).toBe(true);
    }
  });

  it("escapes label values the way the exposition format requires", () => {
    const text = renderMetricsText(
      snapshot({
        roleQueueTasks: [{ role: 'eng"ni\\er\nx', status: "todo", count: 1 }],
      }),
    );
    expect(text).toContain('myrmidon_role_queue_tasks{role="eng\\"ni\\\\er\\nx",status="todo"} 1');
  });

  it("formats sample values without NaN or exponent noise", () => {
    expect(formatSampleValue(0)).toBe("0");
    expect(formatSampleValue(42)).toBe("42");
    expect(formatSampleValue(42.5)).toBe("42.5");
    expect(formatSampleValue(0.1234567)).toBe("0.123457");
  });

  it("computes interpolated percentiles of a sorted sample", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(4.8);
  });

  it("escapeLabelValue round-trips the metacharacters", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeLabelValue("plain")).toBe("plain");
  });
});
