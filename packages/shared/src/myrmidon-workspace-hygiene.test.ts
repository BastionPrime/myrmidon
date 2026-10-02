// myrmidon(WORKSPACE-HYGIENE) part C: the quota values, the resolution order and
// the measurement record. Nothing here touches a database or a disk.

import { describe, expect, it } from "vitest";
import {
  BYTES_PER_MB,
  WORKSPACE_HYGIENE_ENV_KEYS,
  WORKSPACE_HYGIENE_METADATA_KEY,
  WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS,
  isWorkspaceOverQuota,
  megabytesFromBytes,
  mergeWorkspaceHygieneLimits,
  normalizeWorkspaceHygieneLimits,
  parseWorkspaceQuotaValue,
  patchWorkspaceHygieneLimitsSchema,
  readWorkspaceHygieneLimitsFromEnv,
  readWorkspaceHygieneRecord,
  resolveWorkspaceHygieneLimits,
  shouldSignalWorkspaceQuota,
  summarizeWorkspaceMeasurements,
  workspaceHygieneLimitsSchema,
  workspaceQuotaBytes,
  workspaceQuotaSignalDetails,
  writeWorkspaceHygieneRecord,
} from "./myrmidon-workspace-hygiene.js";
import { instanceGeneralSettingsSchema, patchInstanceGeneralSettingsSchema } from "./validators/instance.js";
import type { InstanceGeneralSettings } from "./types/instance.js";

describe("myrmidon(WORKSPACE-HYGIENE): quota values", () => {
  it("reads a positive integer and treats anything else as off", () => {
    expect(parseWorkspaceQuotaValue("12")).toBe(12);
    expect(parseWorkspaceQuotaValue(" 2048 ")).toBe(2048);
    expect(parseWorkspaceQuotaValue(undefined)).toBeNull();
    expect(parseWorkspaceQuotaValue("")).toBeNull();
    expect(parseWorkspaceQuotaValue("0")).toBeNull();
    expect(parseWorkspaceQuotaValue("-5")).toBeNull();
    expect(parseWorkspaceQuotaValue("12.5")).toBeNull();
    expect(parseWorkspaceQuotaValue("many")).toBeNull();
  });

  it("reads the two environment variables and leaves both quotas off by default", () => {
    expect(readWorkspaceHygieneLimitsFromEnv({})).toEqual({
      workspaceQuotaMb: null,
      totalQuotaMb: null,
    });
    expect(
      readWorkspaceHygieneLimitsFromEnv({
        [WORKSPACE_HYGIENE_ENV_KEYS.workspaceQuotaMb]: "4000",
        [WORKSPACE_HYGIENE_ENV_KEYS.totalQuotaMb]: "20000",
      }),
    ).toEqual({ workspaceQuotaMb: 4000, totalQuotaMb: 20000 });
  });

  it("prefers the stored settings and falls back to the environment and the default", () => {
    const stored = { workspaceQuotaMb: 3000, totalQuotaMb: null };
    const resolved = resolveWorkspaceHygieneLimits({
      stored,
      env: { [WORKSPACE_HYGIENE_ENV_KEYS.workspaceQuotaMb]: "100" },
    });
    expect(resolved.limits).toEqual(stored);
    expect(resolved.sources).toEqual({ workspaceQuotaMb: "settings", totalQuotaMb: "settings" });

    const fromEnv = resolveWorkspaceHygieneLimits({
      stored: null,
      env: { [WORKSPACE_HYGIENE_ENV_KEYS.workspaceQuotaMb]: "100" },
    });
    expect(fromEnv.limits).toEqual({ workspaceQuotaMb: 100, totalQuotaMb: null });
    expect(fromEnv.sources).toEqual({ workspaceQuotaMb: "env", totalQuotaMb: "default" });

    const fromDefault = resolveWorkspaceHygieneLimits({});
    expect(fromDefault.limits).toEqual({ workspaceQuotaMb: null, totalQuotaMb: null });
    expect(fromDefault.sources).toEqual({
      workspaceQuotaMb: "default",
      totalQuotaMb: "default",
    });
  });

  it("ignores a stored row it cannot validate instead of reading a quota from it", () => {
    // Zero would mean "signal on every workspace"; a half-written row is not a
    // quota, so the environment decides instead.
    expect(normalizeWorkspaceHygieneLimits({ workspaceQuotaMb: 0, totalQuotaMb: null })).toBeNull();
    expect(normalizeWorkspaceHygieneLimits({ workspaceQuotaMb: 100 })).toBeNull();
    expect(normalizeWorkspaceHygieneLimits({ workspaceQuotaMb: 100, totalQuotaMb: null, x: 1 })).toBeNull();
    expect(normalizeWorkspaceHygieneLimits("4000")).toBeNull();
    const resolved = resolveWorkspaceHygieneLimits({
      stored: { workspaceQuotaMb: 0, totalQuotaMb: null },
      env: { [WORKSPACE_HYGIENE_ENV_KEYS.workspaceQuotaMb]: "512" },
    });
    expect(resolved.limits.workspaceQuotaMb).toBe(512);
    expect(resolved.sources.workspaceQuotaMb).toBe("env");
  });

  it("merges a patch over the effective values and can switch a quota off", () => {
    const base = { workspaceQuotaMb: 4000, totalQuotaMb: 20000 };
    expect(mergeWorkspaceHygieneLimits(base, { workspaceQuotaMb: 5000 })).toEqual({
      workspaceQuotaMb: 5000,
      totalQuotaMb: 20000,
    });
    expect(mergeWorkspaceHygieneLimits(base, { totalQuotaMb: null })).toEqual({
      workspaceQuotaMb: 4000,
      totalQuotaMb: null,
    });
    expect(mergeWorkspaceHygieneLimits(base, {})).toEqual(base);
  });

  it("keeps the validator strict about quota shapes", () => {
    expect(workspaceHygieneLimitsSchema.safeParse({ workspaceQuotaMb: 10, totalQuotaMb: null }).success).toBe(true);
    expect(workspaceHygieneLimitsSchema.safeParse({ workspaceQuotaMb: 10, totalQuotaMb: 0 }).success).toBe(false);
    expect(workspaceHygieneLimitsSchema.safeParse({ workspaceQuotaMb: 10.5, totalQuotaMb: null }).success).toBe(false);
    expect(workspaceHygieneLimitsSchema.safeParse({ workspaceQuotaMb: 10 }).success).toBe(false);
    expect(workspaceHygieneLimitsSchema.safeParse({ workspaceQuotaMb: "10", totalQuotaMb: null }).success).toBe(false);
    expect(patchWorkspaceHygieneLimitsSchema.safeParse({}).success).toBe(true);
    expect(patchWorkspaceHygieneLimitsSchema.safeParse({ workspaceQuotaMb: null }).success).toBe(true);
    expect(patchWorkspaceHygieneLimitsSchema.safeParse({ other: 1 }).success).toBe(false);
  });

  it("is wired into the instance settings contract so a general write keeps the value", () => {
    const general: InstanceGeneralSettings = {
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: { dailyDays: 3, weeklyWeeks: 1, monthlyMonths: 1 },
      workspaceHygiene: { workspaceQuotaMb: 3000, totalQuotaMb: null },
    };
    const parsed = instanceGeneralSettingsSchema.safeParse(general);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workspaceHygiene).toEqual({
      workspaceQuotaMb: 3000,
      totalQuotaMb: null,
    });
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ workspaceHygiene: { workspaceQuotaMb: null, totalQuotaMb: 1 } })
        .success,
    ).toBe(true);
  });
});

describe("myrmidon(WORKSPACE-HYGIENE): the over-quota rule", () => {
  it("is off when there is no quota", () => {
    expect(workspaceQuotaBytes(null)).toBeNull();
    expect(isWorkspaceOverQuota(50 * BYTES_PER_MB, null)).toBe(false);
  });

  it("counts the quota itself as inside it and a byte more as outside", () => {
    expect(isWorkspaceOverQuota(4000 * BYTES_PER_MB, 4000)).toBe(false);
    expect(isWorkspaceOverQuota(4000 * BYTES_PER_MB + 1, 4000)).toBe(true);
  });

  it("reports whole megabytes", () => {
    expect(megabytesFromBytes(0)).toBe(0);
    expect(megabytesFromBytes(1024 * 1024 - 1)).toBe(1);
    expect(megabytesFromBytes(3.4 * BYTES_PER_MB)).toBe(3);
  });

  it("signals once per window and again after it", () => {
    const now = new Date("2026-09-30T12:00:00.000Z");
    const base = { sizeBytes: 5000 * BYTES_PER_MB, quotaMb: 4000, now };
    expect(shouldSignalWorkspaceQuota({ ...base, lastSignalAt: null })).toBe(true);
    expect(shouldSignalWorkspaceQuota({ ...base, lastSignalAt: undefined })).toBe(true);
    expect(
      shouldSignalWorkspaceQuota({ ...base, lastSignalAt: new Date(now.getTime() - 60_000).toISOString() }),
    ).toBe(false);
    expect(
      shouldSignalWorkspaceQuota({
        ...base,
        lastSignalAt: new Date(now.getTime() - WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS).toISOString(),
      }),
    ).toBe(true);
    expect(
      shouldSignalWorkspaceQuota({
        ...base,
        lastSignalAt: new Date(now.getTime() - WORKSPACE_QUOTA_SIGNAL_INTERVAL_MS + 1).toISOString(),
      }),
    ).toBe(false);
    // A record with an unparsable timestamp must not silence the signal forever.
    expect(shouldSignalWorkspaceQuota({ ...base, lastSignalAt: "not-a-date" })).toBe(true);
    // Under the quota there is nothing to signal, whatever the last signal says.
    expect(
      shouldSignalWorkspaceQuota({ ...base, sizeBytes: 10, lastSignalAt: null }),
    ).toBe(false);
  });

  it("builds signal details without host paths", () => {
    const details = workspaceQuotaSignalDetails({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workspaceName: "workspace-a-quotas",
      sizeBytes: 4600 * BYTES_PER_MB,
      quotaMb: 4000,
      measuredAt: "2026-09-30T12:00:00.000Z",
    });
    expect(details).toMatchObject({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      workspaceName: "workspace-a-quotas",
      sizeMb: 4600,
      quotaMb: 4000,
      measuredAt: "2026-09-30T12:00:00.000Z",
    });
    expect(String(details.hint)).toMatch(/merged/i);
    expect(JSON.stringify(details)).not.toMatch(/\/(srv|home|tmp|var)\//);
  });
});

describe("myrmidon(WORKSPACE-HYGIENE): the measurement record", () => {
  const record = {
    measuredAt: "2026-09-30T12:00:00.000Z",
    sizeBytes: 1234,
    entries: 12,
    truncated: false,
    overQuota: false,
    lastSignalAt: null,
  };

  it("writes the record and keeps every other metadata key", () => {
    const written = writeWorkspaceHygieneRecord(
      { reopenPendingConsumptionAt: "2026-09-01T00:00:00.000Z", lifecycleGeneration: 3 },
      record,
    );
    expect(written.reopenPendingConsumptionAt).toBe("2026-09-01T00:00:00.000Z");
    expect(written.lifecycleGeneration).toBe(3);
    expect(written[WORKSPACE_HYGIENE_METADATA_KEY]).toEqual(record);
    expect(writeWorkspaceHygieneRecord(null, record)[WORKSPACE_HYGIENE_METADATA_KEY]).toEqual(record);
  });

  it("reads a record back and ignores a malformed one", () => {
    expect(readWorkspaceHygieneRecord({ [WORKSPACE_HYGIENE_METADATA_KEY]: record })).toEqual(record);
    expect(readWorkspaceHygieneRecord({})).toBeNull();
    expect(readWorkspaceHygieneRecord(null)).toBeNull();
    expect(
      readWorkspaceHygieneRecord({ [WORKSPACE_HYGIENE_METADATA_KEY]: { ...record, sizeBytes: -1 } }),
    ).toBeNull();
    expect(
      readWorkspaceHygieneRecord({ [WORKSPACE_HYGIENE_METADATA_KEY]: { measuredAt: record.measuredAt } }),
    ).toBeNull();
  });

  it("sums what the measured workspaces hold", () => {
    expect(
      summarizeWorkspaceMeasurements([
        { sizeBytes: 10, overQuota: true },
        { sizeBytes: 32, overQuota: false },
      ]),
    ).toEqual({ measuredWorkspaces: 2, totalBytes: 42, overQuotaCount: 1 });
    expect(summarizeWorkspaceMeasurements([])).toEqual({
      measuredWorkspaces: 0,
      totalBytes: 0,
      overQuotaCount: 0,
    });
  });
});