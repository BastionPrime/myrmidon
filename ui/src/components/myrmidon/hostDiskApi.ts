// Host disk usage (myrmidon BOT-DISK E):
// GET/PATCH /api/myrmidon/host-disk.
//
// GET reports the threshold in force, where it came from and the state of the
// last sweep (usage, growth per hour, biggest consumers). PATCH saves the
// threshold to the instance settings and it applies immediately, without
// restarting the server.
import { api } from "@/api/client";

export type HostDiskLimitSource = "settings" | "env" | "default";

export interface HostDiskView {
  threshold: {
    usageThresholdPercent: number;
    sources: { usageThresholdPercent: HostDiskLimitSource };
  };
  status: {
    usage: {
      measuredPath: string | null;
      usedPercent: number | null;
      usedGb: number | null;
      totalGb: number | null;
      freeGb: number | null;
      growthBytesPerHour: number | null;
      measuredAt: string | null;
    };
    consumers: Array<{ path: string; sizeGb: number }>;
    overThreshold: boolean;
    lastSweepAt: string | null;
    lastSignalAt: string | null;
  };
}

export const hostDiskQueryKey = ["myrmidon", "host-disk"] as const;

export const hostDiskApi = {
  get: () => api.get<HostDiskView>("/myrmidon/host-disk"),
  update: (patch: { usageThresholdPercent: number }) =>
    api.patch<HostDiskView>("/myrmidon/host-disk", patch),
};
