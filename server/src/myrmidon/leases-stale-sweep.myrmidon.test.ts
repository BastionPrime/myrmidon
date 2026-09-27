import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_LEASE_GRACE_MS,
  STALE_LEASE_SWEEP_PAGE_SIZE,
  readStaleLeaseGraceMs,
} from "./leases-stale-sweep.js";

describe("readStaleLeaseGraceMs", () => {
  it("defaults to 10 minutes", () => {
    expect(DEFAULT_STALE_LEASE_GRACE_MS).toBe(600_000);
    expect(readStaleLeaseGraceMs({})).toBe(600_000);
  });

  it("reads milliseconds and falls back on invalid values", () => {
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "60000" })).toBe(60_000);
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "0" })).toBe(0);
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "-1" })).toBe(600_000);
    expect(readStaleLeaseGraceMs({ MYRMIDON_STALE_LEASE_GRACE_MS: "10m" })).toBe(600_000);
  });

  it("caps a tick at 50 leases", () => {
    expect(STALE_LEASE_SWEEP_PAGE_SIZE).toBe(50);
  });
});
