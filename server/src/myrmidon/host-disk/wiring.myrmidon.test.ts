// myrmidon(BOT-DISK E): the production wiring, not a mock of it.
//
// Same regression shape the workspace-hygiene wiring test pins: a wrapper
// mistake in the settings resolution (handing the sweep `{ settings, sources }`
// instead of `HostDiskSettings`) silently reads the threshold as undefined,
// never signals, and every unit test stays green because they inject their
// own resolveSettings. This file builds the sweep through the real helper from
// index.ts, so the same mistake turns it red again.

import { describe, expect, it, vi } from "vitest";
import { type HostDiskSettings } from "@paperclipai/shared";
import type { LogActivityInput } from "../../services/activity-log.js";
import {
  hostDiskConsumerPaths,
  hostDiskDataRoot,
  resolveSweepSettings,
} from "./index.js";
import { createHostDiskSweep } from "./sweep.js";

const GB = 1024 * 1024 * 1024;

describe("myrmidon(BOT-DISK E): the settings the runtime resolves", () => {
  it("returns the settings, not the { settings, sources } wrapper the API reports", async () => {
    const settings = {
      getGeneral: async () => ({ hostDisk: { usageThresholdPercent: 70 } }),
    };
    const resolved: HostDiskSettings = await resolveSweepSettings(settings, {});
    expect(resolved).toEqual({ usageThresholdPercent: 70 });
    expect((resolved as { sources?: unknown }).sources).toBeUndefined();
    expect(Object.keys(resolved).sort()).toEqual(["usageThresholdPercent"]);
  });

  it("falls back to the environment when the row holds nothing", async () => {
    const settings = { getGeneral: async () => ({}) };
    const resolved = await resolveSweepSettings(settings, {
      MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT: "80",
    });
    expect(resolved).toEqual({ usageThresholdPercent: 80 });
  });

  it("falls back to the default 85 when nothing is set", async () => {
    const settings = { getGeneral: async () => ({ hostDisk: null }) };
    const resolved = await resolveSweepSettings(settings, {});
    expect(resolved).toEqual({ usageThresholdPercent: 85 });
  });

  it("ignores a hand-edited row that does not validate", async () => {
    const settings = { getGeneral: async () => ({ hostDisk: { usageThresholdPercent: "ninety" } }) };
    const resolved = await resolveSweepSettings(settings, {});
    expect(resolved).toEqual({ usageThresholdPercent: 85 });
  });
});

describe("myrmidon(BOT-DISK E): a sweep through the real wiring", () => {
  it("a stored threshold that usage crosses produces the signal with the numbers", async () => {
    const settings = { getGeneral: async () => ({ hostDisk: { usageThresholdPercent: 70 } }) };
    const logActivity = vi.fn(async (_entry: LogActivityInput) => ({}));
    const sweep = createHostDiskSweep({
      dataRootPath: "/srv/data",
      consumerPaths: ["/srv/data/workspaces", "/srv/data/backups"],
      resolveSettings: () => resolveSweepSettings(settings, {}),
      logActivity,
      lastSignalAt: async () => null,
      logger: { error: vi.fn(), info: vi.fn() },
      measureUsage: async () => ({
        path: "/srv/data",
        usedBytes: 91 * GB,
        totalBytes: 100 * GB,
        freeBytes: 9 * GB,
        usedPercent: 91,
      }),
      measureConsumer: async (directory: string) => ({
        sizeBytes: directory === "/srv/data/workspaces" ? 40 * GB : 5 * GB,
        truncated: false,
      }),
      now: () => new Date("2026-10-03T12:00:00.000Z"),
    });

    const result = await sweep.sweep();

    // The regression guard: the wrapper mistake reads the threshold as
    // undefined and overThreshold goes false here while unit tests stay green.
    expect(result.overThreshold).toBe(true);
    expect(result.signalled).toBe(true);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0]![0]).toMatchObject({
      action: "host.disk_threshold_exceeded",
      entityType: "host_disk",
      entityId: "/srv/data",
    });
    expect(logActivity.mock.calls[0]![0].details).toMatchObject({
      usedPercent: 91,
      thresholdPercent: 70,
      usedGb: 91,
      totalGb: 100,
      freeGb: 9,
      growthBytesPerHour: null,
      measuredPath: "/srv/data",
    });
    // The consumers arrive ranked biggest-first.
    expect(result.consumers).toEqual([
      { path: "/srv/data/workspaces", sizeBytes: 40 * GB },
      { path: "/srv/data/backups", sizeBytes: 5 * GB },
    ]);
  });

  it("a threshold change applies on the very next sweep without a rebuild", async () => {
    let threshold = 70;
    const settings = { getGeneral: async () => ({ hostDisk: { usageThresholdPercent: threshold } }) };
    const sweep = createHostDiskSweep({
      dataRootPath: "/srv/data",
      consumerPaths: [],
      resolveSettings: () => resolveSweepSettings(settings, {}),
      logActivity: vi.fn(async () => ({})),
      lastSignalAt: async () => null,
      logger: { error: vi.fn(), info: vi.fn() },
      measureUsage: async () => ({
        path: "/srv/data",
        usedBytes: 60 * GB,
        totalBytes: 100 * GB,
        freeBytes: 40 * GB,
        usedPercent: 60,
      }),
      now: () => new Date("2026-10-03T12:00:00.000Z"),
    });
    await sweep.sweep();
    expect(sweep.lastResult()?.overThreshold).toBe(false);
    threshold = 50;
    await sweep.sweep();
    expect(sweep.lastResult()?.overThreshold).toBe(true);
  });
});

describe("myrmidon(BOT-DISK E): paths from the environment", () => {
  it("defaults the data root to /data and the consumers to the data root", () => {
    expect(hostDiskDataRoot({})).toBe("/data");
    expect(hostDiskConsumerPaths({})).toEqual(["/data"]);
  });

  it("reads an explicit data root and a comma-separated consumer list", () => {
    expect(hostDiskDataRoot({ MYRMIDON_HOST_DISK_DATA_ROOT: "/srv" })).toBe("/srv");
    expect(
      hostDiskConsumerPaths({ MYRMIDON_HOST_DISK_CONSUMER_PATHS: "/srv/a, /srv/b" }),
    ).toEqual(["/srv/a", "/srv/b"]);
  });
});
