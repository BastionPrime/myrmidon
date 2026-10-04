import { describe, expect, it } from "vitest";
import {
  HOST_DISK_DEFAULT_USAGE_THRESHOLD_PERCENT,
  HOST_DISK_SIGNAL_INTERVAL_MS,
  gigabytesFromBytes,
  hostDiskGrowthBytesPerHour,
  hostDiskSettingsSchema,
  isHostDiskOverThreshold,
  mergeHostDiskSettings,
  normalizeHostDiskSettings,
  parseHostDiskThresholdValue,
  patchHostDiskSettingsSchema,
  resolveHostDiskSettings,
  type HostDiskUsageSample,
} from "./myrmidon-host-disk.js";

describe("hostDiskSettingsSchema", () => {
  it("accepts an integer threshold in 1-99", () => {
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 85 }).success).toBe(true);
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 1 }).success).toBe(true);
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 99 }).success).toBe(true);
  });

  it("rejects a threshold outside 1-99, fractional, non-numeric and unknown keys", () => {
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 0 }).success).toBe(false);
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 100 }).success).toBe(false);
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 85.5 }).success).toBe(false);
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: "85" }).success).toBe(false);
    expect(hostDiskSettingsSchema.safeParse({ usageThresholdPercent: 85, extra: 1 }).success).toBe(false);
  });
});

describe("patchHostDiskSettingsSchema", () => {
  it("accepts a subset and rejects an invalid value", () => {
    expect(patchHostDiskSettingsSchema.safeParse({}).success).toBe(true);
    expect(patchHostDiskSettingsSchema.safeParse({ usageThresholdPercent: 90 }).success).toBe(true);
    expect(patchHostDiskSettingsSchema.safeParse({ usageThresholdPercent: 0 }).success).toBe(false);
  });
});

describe("parseHostDiskThresholdValue", () => {
  it("returns null for unset, non-numeric, fractional and out-of-range values", () => {
    expect(parseHostDiskThresholdValue(undefined)).toBeNull();
    expect(parseHostDiskThresholdValue("")).toBeNull();
    expect(parseHostDiskThresholdValue("abc")).toBeNull();
    expect(parseHostDiskThresholdValue("85.5")).toBeNull();
    expect(parseHostDiskThresholdValue("0")).toBeNull();
    expect(parseHostDiskThresholdValue("100")).toBeNull();
    expect(parseHostDiskThresholdValue(" 90 ")).toBe(90);
  });
});

describe("resolveHostDiskSettings", () => {
  it("prefers a valid stored row, then the environment, then the default", () => {
    expect(resolveHostDiskSettings({ stored: { usageThresholdPercent: 90 } })).toEqual({
      settings: { usageThresholdPercent: 90 },
      sources: { usageThresholdPercent: "settings" },
    });
    expect(resolveHostDiskSettings({ env: { MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT: "80" } })).toEqual({
      settings: { usageThresholdPercent: 80 },
      sources: { usageThresholdPercent: "env" },
    });
    expect(resolveHostDiskSettings({})).toEqual({
      settings: { usageThresholdPercent: HOST_DISK_DEFAULT_USAGE_THRESHOLD_PERCENT },
      sources: { usageThresholdPercent: "default" },
    });
    expect(resolveHostDiskSettings({ stored: { usageThresholdPercent: "bogus" } })).toEqual({
      settings: { usageThresholdPercent: HOST_DISK_DEFAULT_USAGE_THRESHOLD_PERCENT },
      sources: { usageThresholdPercent: "default" },
    });
    expect(resolveHostDiskSettings({ env: { MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT: "101" } })).toEqual({
      settings: { usageThresholdPercent: HOST_DISK_DEFAULT_USAGE_THRESHOLD_PERCENT },
      sources: { usageThresholdPercent: "default" },
    });
  });
});

describe("mergeHostDiskSettings", () => {
  it("keeps the base value when the patch key is absent", () => {
    expect(mergeHostDiskSettings({ usageThresholdPercent: 85 }, {})).toEqual({ usageThresholdPercent: 85 });
    expect(mergeHostDiskSettings({ usageThresholdPercent: 85 }, { usageThresholdPercent: 70 })).toEqual({
      usageThresholdPercent: 70,
    });
  });
});

describe("normalizeHostDiskSettings", () => {
  it("returns null for anything the schema rejects", () => {
    expect(normalizeHostDiskSettings(null)).toBeNull();
    expect(normalizeHostDiskSettings({ usageThresholdPercent: null })).toBeNull();
    expect(normalizeHostDiskSettings("85")).toBeNull();
    expect(normalizeHostDiskSettings({ usageThresholdPercent: 85 })).toEqual({ usageThresholdPercent: 85 });
  });
});

function sample(at: string, usedBytes: number): HostDiskUsageSample {
  return { measuredAt: at, usedPercent: 50, usedBytes, totalBytes: 1000 };
}

describe("hostDiskGrowthBytesPerHour", () => {
  it("computes the bytes-per-hour slope between the oldest and the newest sample", () => {
    const hour = 60 * 60 * 1000;
    const t0 = Date.parse("2026-10-03T00:00:00Z");
    const samples = [
      sample(new Date(t0).toISOString(), 1000),
      sample(new Date(t0 + 30 * 60 * 1000).toISOString(), 1500),
      sample(new Date(t0 + hour).toISOString(), 2000),
    ];
    expect(hostDiskGrowthBytesPerHour(samples)).toBe(1000);
  });

  it("returns null with fewer than two samples or a non-positive window", () => {
    expect(hostDiskGrowthBytesPerHour([sample("2026-10-03T00:00:00Z", 1)])).toBeNull();
    expect(hostDiskGrowthBytesPerHour([])).toBeNull();
    expect(
      hostDiskGrowthBytesPerHour([
        sample("2026-10-03T00:00:00Z", 1),
        sample("2026-10-03T00:00:00Z", 2),
      ]),
    ).toBeNull();
  });
});

describe("isHostDiskOverThreshold", () => {
  it("fires at the threshold, not only above it", () => {
    expect(isHostDiskOverThreshold(85, 85)).toBe(true);
    expect(isHostDiskOverThreshold(84, 85)).toBe(false);
    expect(isHostDiskOverThreshold(86, 85)).toBe(true);
  });
});

describe("gigabytesFromBytes", () => {
  it("rounds to whole gigabytes and never goes below zero", () => {
    expect(gigabytesFromBytes(0)).toBe(0);
    expect(gigabytesFromBytes(5 * 1024 * 1024 * 1024)).toBe(5);
  });
});

describe("signal interval", () => {
  it("is six hours, so a crossed threshold re-signals four times a day at most", () => {
    expect(HOST_DISK_SIGNAL_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
