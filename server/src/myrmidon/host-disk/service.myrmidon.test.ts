import { describe, expect, it, vi } from "vitest";
import { hostDiskService } from "./service.js";
import type { HostDiskServiceDeps } from "./service.js";
import type { HostDiskSweepResult } from "./state.js";

function deps(overrides: Partial<HostDiskServiceDeps> = {}, stored: unknown = undefined): HostDiskServiceDeps {
  const settingsRow: { hostDisk?: unknown } = stored === undefined ? {} : { hostDisk: stored };
  return {
    settings: {
      getGeneral: async () => settingsRow,
      updateGeneral: async (patch) => {
        settingsRow.hostDisk = patch.hostDisk;
        return patch;
      },
    },
    listCompanyIds: async () => ["company-1"],
    logActivity: vi.fn(async () => undefined),
    lastSignalAt: async () => null,
    env: {},
    ...overrides,
  };
}

const sweep: HostDiskSweepResult = {
  at: "2026-10-03T00:00:00Z",
  measuredPath: "/srv/data",
  usedPercent: 91,
  usedBytes: 91 * 1024 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024 * 1024,
  freeBytes: 9 * 1024 * 1024 * 1024,
  overThreshold: true,
  thresholdPercent: 85,
  growthBytesPerHour: 1024 * 1024 * 1024,
  consumers: [{ path: "/srv/data/workspaces", sizeBytes: 40 * 1024 * 1024 * 1024 }],
  signalled: true,
  error: null,
};

describe("hostDiskService read", () => {
  it("reports the default threshold and the sweep state", async () => {
    const service = hostDiskService({ ...deps({ lastSweep: () => sweep }) });
    const view = await service.read();
    expect(view.threshold.usageThresholdPercent).toBe(85);
    expect(view.threshold.sources.usageThresholdPercent).toBe("default");
    expect(view.status.usage.usedPercent).toBe(91);
    expect(view.status.usage.growthBytesPerHour).toBe(1024 * 1024 * 1024);
    expect(view.status.consumers).toEqual([{ path: "/srv/data/workspaces", sizeGb: 40 }]);
    expect(view.status.overThreshold).toBe(true);
  });

  it("reports the env source when the env var is set and nothing is stored", async () => {
    const service = hostDiskService({
      ...deps({ lastSweep: () => null }),
      env: { MYRMIDON_HOST_DISK_USAGE_THRESHOLD_PERCENT: "80" },
    });
    const view = await service.read();
    expect(view.threshold.usageThresholdPercent).toBe(80);
    expect(view.threshold.sources.usageThresholdPercent).toBe("env");
    expect(view.status.usage.usedPercent).toBeNull();
  });
});

describe("hostDiskService update", () => {
  it("saves the threshold, audits it for every company and applies it on the next read", async () => {
    const logActivity = vi.fn();
    const base = deps({ logActivity, lastSweep: () => sweep });
    const service = hostDiskService(base);
    const view = await service.update({ usageThresholdPercent: 70 }, {
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
    });
    expect(view.threshold.usageThresholdPercent).toBe(70);
    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.action).toBe("instance.host_disk.updated");
    expect(entry.companyId).toBe("company-1");
    expect(entry.details).toEqual({
      previous: { usageThresholdPercent: 85 },
      next: { usageThresholdPercent: 70 },
      changedKeys: ["usageThresholdPercent"],
    });
    const after = await service.read();
    expect(after.threshold.usageThresholdPercent).toBe(70);
    expect(after.threshold.sources.usageThresholdPercent).toBe("settings");
  });

  it("keeps the stored threshold when the patch is empty", async () => {
    const logActivity = vi.fn();
    const service = hostDiskService(deps({ logActivity }, { usageThresholdPercent: 70 }));
    const view = await service.update({}, {
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
    });
    expect(view.threshold.usageThresholdPercent).toBe(70);
    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.details.changedKeys).toEqual([]);
  });
});
