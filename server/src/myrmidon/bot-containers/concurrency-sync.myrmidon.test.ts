// myrmidon(CONCURRENCY-SYNC): the board's concurrency limit against the applied one.
// Pure: the clock is an argument, and the applied value comes from a marker, so a whole
// reconcile cycle (card edited -> still diverged -> reconciler pass -> in sync) is a
// unit test here, without a container or a database.

import { describe, expect, it } from "vitest";
import {
  APPLIED_LIMIT_PENDING_NOTE,
  compareGatewayConcurrency,
  EXTERNAL_GATEWAY_NOTE,
  externalGatewayRateLimitWarning,
  GATEWAY_RATE_LIMITED_ERROR_CODE,
  GATEWAY_RATE_LIMIT_LOOKBACK_MS,
} from "./concurrency-sync.js";
import { classifyProfileChange, type CompiledProfile } from "./types.js";

const NOW = "2026-01-01T00:00:00.000Z";

function profile(overrides: Partial<CompiledProfile> = {}): CompiledProfile {
  return { botKey: "agent-a", files: [], restartHash: "r", filesHash: "f", maxConcurrentRuns: 3, ...overrides };
}

describe("myrmidon(CONCURRENCY-SYNC) compareGatewayConcurrency", () => {
  it("agrees when the applied value equals the board's", () => {
    expect(compareGatewayConcurrency({ board: 3, applied: 3, checkedAt: NOW })).toEqual({
      board: 3,
      applied: 3,
      diverged: false,
      checkedAt: NOW,
    });
  });

  it("flags a divergence when the applied value differs", () => {
    expect(compareGatewayConcurrency({ board: 3, applied: 2, checkedAt: NOW }).diverged).toBe(true);
    expect(compareGatewayConcurrency({ board: 2, applied: 3, checkedAt: NOW }).diverged).toBe(true);
    expect(compareGatewayConcurrency({ board: 3, applied: 2, checkedAt: NOW }).applied).toBe(2);
  });

  it("never reports a divergence for a value nothing reported", () => {
    // The gateway said nothing: that is "unknown", not "differs from the board".
    expect(compareGatewayConcurrency({ board: 3, applied: null, checkedAt: NOW })).toEqual({
      board: 3,
      applied: null,
      diverged: false,
      checkedAt: NOW,
    });
  });
});

describe("myrmidon(CONCURRENCY-SYNC) externalGatewayRateLimitWarning", () => {
  it("warns when the board asks for more than one run and the gateway refused one", () => {
    const warning = externalGatewayRateLimitWarning({ board: 3, rateLimitedAt: NOW });
    expect(warning).toContain(NOW);
    expect(warning).toContain("below the board's limit");
  });

  it("stays quiet without a rate-limited run, or when the board asks for one run anyway", () => {
    expect(externalGatewayRateLimitWarning({ board: 3, rateLimitedAt: null })).toBeNull();
    // A board limit of 1 already asks for exactly what a 429 would enforce.
    expect(externalGatewayRateLimitWarning({ board: 1, rateLimitedAt: NOW })).toBeNull();
  });
});

describe("myrmidon(CONCURRENCY-SYNC) classifyProfileChange", () => {
  it("heals an applied state that does not report the limit without restarting a live gateway", () => {
    // A container whose marker predates the field: same hashes, no number recorded.
    // The class must be "files" — writeProfile rewrites the identical files and with
    // them the marker, and a running gateway is not restarted for it.
    const applied = { restartHash: "r", filesHash: "f" };
    expect(classifyProfileChange(applied, profile())).toBe("files");
  });

  it("is unchanged once the marker reports the limit, and drops no reason to change", () => {
    const applied = { restartHash: "r", filesHash: "f", maxConcurrentRuns: 3 };
    expect(classifyProfileChange(applied, profile())).toBe("none");
    // The number is a line of config.yaml, so a new one already moves restartHash: the
    // comparison above never has to look at the number to catch a change.
    expect(classifyProfileChange(applied, profile({ maxConcurrentRuns: 4, restartHash: "r2" }))).toBe("restart");
    expect(classifyProfileChange(applied, profile({ filesHash: "f2" }))).toBe("files");
  });

  it("keeps the restart class first for a profile that has to be restarted", () => {
    expect(classifyProfileChange({}, profile())).toBe("restart");
    expect(classifyProfileChange({ restartHash: "r" }, profile({ restartHash: "r2" }))).toBe("restart");
  });

  it("says nothing about a limit when the next profile carries none", () => {
    const applied = { restartHash: "r", filesHash: "f" };
    expect(classifyProfileChange(applied, profile({ maxConcurrentRuns: undefined }))).toBe("none");
  });
});

describe("myrmidon(CONCURRENCY-SYNC) wording", () => {
  it("names the run error it looks for and its window", () => {
    expect(GATEWAY_RATE_LIMITED_ERROR_CODE).toBe("hermes_gateway_rate_limited");
    expect(GATEWAY_RATE_LIMIT_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("explains a missing applied value and an unmanaged gateway", () => {
    expect(APPLIED_LIMIT_PENDING_NOTE).toContain("does not report");
    expect(APPLIED_LIMIT_PENDING_NOTE).toContain("no restart");
    expect(EXTERNAL_GATEWAY_NOTE).toContain("not managed by the board");
  });
});