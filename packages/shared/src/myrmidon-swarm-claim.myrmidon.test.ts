// myrmidon(1.6-SWARM): the shared contract of per-role queues with leased
// claims. These tests pin the decisions the core queue and the supervisor view
// share — the queue order, the lease states, the settings precedence and the
// per-agent ceiling — so a later change to one of them cannot drift past them.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWARM_CLAIM_ENABLED,
  DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC,
  DEFAULT_SWARM_LEASE_TTL_SEC,
  DEFAULT_SWARM_MAX_ACTIVE_TASKS,
  SWARM_CLAIM_ENV_KEYS,
  SWARM_CLAIM_RELEASE_REASON_SUPERVISOR_REBALANCE,
  SWARM_CLAIM_SUPERVISOR_RELEASED_ACTION,
  SWARM_CLAIM_WAKE_REASON,
  isSwarmLeaseExpired,
  isSwarmLeaseLive,
  mergeSwarmClaimSettings,
  normalizeSwarmClaimSettings,
  orderSwarmQueueCandidates,
  parseSwarmClaimEnabled,
  readSwarmClaimSettingsFromEnv,
  resolveSwarmClaimSettings,
  swarmActiveTaskLimitReached,
  swarmLeaseExpiresAt,
  swarmPriorityRank,
} from "./myrmidon-swarm-claim.js";

describe("swarm claim settings", () => {
  it("ships the pilot dark and reads an explicit on", () => {
    expect(DEFAULT_SWARM_CLAIM_ENABLED).toBe(false);
    expect(readSwarmClaimSettingsFromEnv({}).enabled).toBe(false);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "1" }).enabled).toBe(true);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "on" }).enabled).toBe(true);
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.enabled]: "false" }).enabled).toBe(false);
    // A typo must not silently extinguish (or enable) the pilot.
    expect(parseSwarmClaimEnabled("ture")).toBeNull();
    expect(parseSwarmClaimEnabled(" 1 ")).toBe(true);
  });

  it("uses the documented defaults for the lease, the ceiling and the sweep", () => {
    const settings = readSwarmClaimSettingsFromEnv({});
    expect(settings.leaseTtlSec).toBe(DEFAULT_SWARM_LEASE_TTL_SEC);
    expect(settings.maxActiveTasks).toBe(DEFAULT_SWARM_MAX_ACTIVE_TASKS);
    expect(settings.sweepIntervalSec).toBe(DEFAULT_SWARM_CLAIM_SWEEP_INTERVAL_SEC);
  });

  it("reads the environment values and refuses out-of-range ones", () => {
    const settings = readSwarmClaimSettingsFromEnv({
      [SWARM_CLAIM_ENV_KEYS.leaseTtlSec]: "120",
      [SWARM_CLAIM_ENV_KEYS.maxActiveTasks]: "1",
      [SWARM_CLAIM_ENV_KEYS.sweepIntervalSec]: "10",
    });
    expect(settings).toMatchObject({ leaseTtlSec: 120, maxActiveTasks: 1, sweepIntervalSec: 10 });

    // Out of range falls back to the default, it never becomes a wider window.
    expect(readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.leaseTtlSec]: "10" }).leaseTtlSec).toBe(
      DEFAULT_SWARM_LEASE_TTL_SEC,
    );
    expect(
      readSwarmClaimSettingsFromEnv({ [SWARM_CLAIM_ENV_KEYS.maxActiveTasks]: "0" }).maxActiveTasks,
    ).toBeNull();
  });

  it("stored settings win over the environment; an unreadable row is ignored", () => {
    const stored = {
      enabled: true,
      leaseTtlSec: 300,
      maxActiveTasks: 5,
      sweepIntervalSec: 45,
    };
    const resolved = resolveSwarmClaimSettings({
      stored,
      env: { [SWARM_CLAIM_ENV_KEYS.enabled]: "0" },
    });
    expect(resolved.settings).toEqual(stored);
    expect(resolved.sources.enabled).toBe("settings");

    const fromEnv = resolveSwarmClaimSettings({
      stored: { enabled: "maybe" },
      env: { [SWARM_CLAIM_ENV_KEYS.enabled]: "1" },
    });
    expect(fromEnv.settings.enabled).toBe(true);
    expect(fromEnv.sources.enabled).toBe("env");

    expect(resolveSwarmClaimSettings({}).sources.enabled).toBe("default");
    expect(normalizeSwarmClaimSettings({ enabled: true })).toBeNull();
  });

  it("merges a patch without dropping the keys it does not name", () => {
    const base = readSwarmClaimSettingsFromEnv({});
    expect(mergeSwarmClaimSettings(base, { enabled: true })).toEqual({ ...base, enabled: true });
    expect(mergeSwarmClaimSettings(base, { maxActiveTasks: null }).maxActiveTasks).toBeNull();
  });

  it("moves the expiry forward by exactly one TTL", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    expect(swarmLeaseExpiresAt(now, { leaseTtlSec: 900 }).toISOString()).toBe(
      "2026-10-02T12:15:00.000Z",
    );
  });
});

describe("swarm active task ceiling", () => {
  it("is reached at the ceiling and off when the setting is null", () => {
    expect(swarmActiveTaskLimitReached(2, { maxActiveTasks: 3 })).toBe(false);
    expect(swarmActiveTaskLimitReached(3, { maxActiveTasks: 3 })).toBe(true);
    expect(swarmActiveTaskLimitReached(999, { maxActiveTasks: null })).toBe(false);
  });
});

describe("swarm queue order", () => {
  it("puts a critical task at the top of the queue", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "a", priority: "low", queuedAt: "2026-10-02T09:00:00Z" },
      { issueId: "b", priority: "critical", queuedAt: "2026-10-02T11:00:00Z" },
      { issueId: "c", priority: "high", queuedAt: "2026-10-02T08:00:00Z" },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["b", "c", "a"]);
    expect(swarmPriorityRank("critical")).toBeLessThan(swarmPriorityRank("high"));
    expect(swarmPriorityRank(null)).toBe(4);
  });

  it("breaks a priority tie by the older queue entry", () => {
    const ordered = orderSwarmQueueCandidates([
      { issueId: "newer", priority: "high", queuedAt: "2026-10-02T11:00:00Z" },
      { issueId: "older", priority: "high", queuedAt: "2026-10-02T07:00:00Z" },
    ]);
    expect(ordered.map((c) => c.issueId)).toEqual(["older", "newer"]);
  });

  it("does not mutate the input", () => {
    const input = [
      { issueId: "a", priority: "low", queuedAt: 0 } as const,
      { issueId: "b", priority: "critical", queuedAt: 0 } as const,
    ];
    orderSwarmQueueCandidates(input);
    expect(input[0].issueId).toBe("a");
  });
});

describe("swarm lease state", () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  const base = { id: "l1", issueId: "i1", agentId: "a1", heartbeatAt: now };

  it("is live before the expiry and expired at or after it", () => {
    const live = { ...base, expiresAt: "2026-10-02T12:05:00.000Z", releasedAt: null };
    expect(isSwarmLeaseLive(live, now)).toBe(true);
    expect(isSwarmLeaseExpired(live, now)).toBe(false);

    const expired = { ...base, expiresAt: "2026-10-02T11:59:59.000Z", releasedAt: null };
    expect(isSwarmLeaseLive(expired, now)).toBe(false);
    expect(isSwarmLeaseExpired(expired, now)).toBe(true);
  });

  it("treats a released lease as neither live nor expired", () => {
    const released = {
      ...base,
      expiresAt: "2026-10-02T12:05:00.000Z",
      releasedAt: "2026-10-02T11:50:00.000Z",
    };
    expect(isSwarmLeaseLive(released, now)).toBe(false);
    expect(isSwarmLeaseExpired(released, now)).toBe(false);
  });

  it("does not call a lease without an expiry live", () => {
    expect(isSwarmLeaseLive({ ...base, expiresAt: null, releasedAt: null }, now)).toBe(false);
  });
});

describe("swarm names shared with the supervisor part", () => {
  it("pins the wake reason and the supervisor action the two parts agree on", () => {
    expect(SWARM_CLAIM_WAKE_REASON).toBe("swarm_claim_queue");
    expect(SWARM_CLAIM_RELEASE_REASON_SUPERVISOR_REBALANCE).toBe("supervisor_rebalance");
    expect(SWARM_CLAIM_SUPERVISOR_RELEASED_ACTION).toBe("issue.swarm_claim.supervisor_released");
  });
});