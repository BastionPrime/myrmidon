import {
  HOST_DISK_SIGNAL_INTERVAL_MS,
  HOST_DISK_THRESHOLD_EXCEEDED_ACTION,
  gigabytesFromBytes,
  hostDiskGrowthBytesPerHour,
  isHostDiskOverThreshold,
  type HostDiskConsumerEntry,
  type HostDiskSettings,
  type HostDiskUsageSample,
} from "@paperclipai/shared";
import type { LogActivityInput } from "../../services/activity-log.js";
import { measureHostDiskConsumer, readHostDiskUsage } from "./measure.js";
import { HostDiskSampleRing, type HostDiskSweepResult } from "./state.js";

/**
 * One sweep of the host disk (myrmidon BOT-DISK, part E).
 *
 * Every call: read the threshold in force (so a saved settings change applies
 * without a restart), `statfs` the data root, push the sample into the ring,
 * and when usage crosses the threshold, walk the top-level directories of the
 * data root for the biggest consumers and write one activity-log line — at
 * most once per `signalIntervalMs`, anchored on the newest line of the same
 * action, exactly like the workspace quota signal.
 *
 * The sweep is a signal, never a reaper: it deletes nothing.
 */

export interface HostDiskSweepDeps {
  /** Directory whose filesystem usage is measured (the server data root). */
  dataRootPath: string;
  /** Directories under the data root ranked as "biggest consumers" when a signal is due. */
  consumerPaths: string[];
  resolveSettings: () => Promise<HostDiskSettings>;
  logActivity: (entry: LogActivityInput) => Promise<unknown>;
  lastSignalAt: () => Promise<Date | null>;
  logger: { error: (entry: object, message: string) => void; info: (entry: object, message: string) => void };
  signalIntervalMs?: number;
  /** Samples per path kept for the growth rate. */
  maxSamples?: number;
  measureUsage?: typeof readHostDiskUsage;
  measureConsumer?: typeof measureHostDiskConsumer;
  now?: () => Date;
}

export interface HostDiskSweep {
  sweep(): Promise<HostDiskSweepResult>;
  lastResult(): HostDiskSweepResult | null;
  samples(): HostDiskUsageSample[];
  consumers(): HostDiskConsumerEntry[];
}

export function createHostDiskSweep(deps: HostDiskSweepDeps): HostDiskSweep {
  const now = deps.now ?? (() => new Date());
  const measureUsage = deps.measureUsage ?? readHostDiskUsage;
  const measureConsumer = deps.measureConsumer ?? measureHostDiskConsumer;
  const signalIntervalMs = deps.signalIntervalMs ?? HOST_DISK_SIGNAL_INTERVAL_MS;
  const ring = new HostDiskSampleRing(deps.maxSamples ?? 24);
  let lastResult: HostDiskSweepResult | null = null;
  let consumers: HostDiskConsumerEntry[] = [];

  async function sweep(): Promise<HostDiskSweepResult> {
    const settings = await deps.resolveSettings();
    const usage = await measureUsage(deps.dataRootPath);
    if (!usage) {
      const result: HostDiskSweepResult = {
        at: now().toISOString(),
        measuredPath: null,
        usedPercent: null,
        usedBytes: null,
        totalBytes: null,
        freeBytes: null,
        overThreshold: false,
        thresholdPercent: settings.usageThresholdPercent,
        growthBytesPerHour: null,
        consumers: [],
        signalled: false,
        error: "usage unavailable",
      };
      lastResult = result;
      deps.logger.error({ path: deps.dataRootPath }, "host disk usage could not be read");
      return result;
    }

    const sample: HostDiskUsageSample = {
      measuredAt: now().toISOString(),
      usedPercent: usage.usedPercent,
      usedBytes: usage.usedBytes,
      totalBytes: usage.totalBytes,
    };
    ring.push(sample);
    const growthBytesPerHour = hostDiskGrowthBytesPerHour(ring.list());

    const overThreshold = isHostDiskOverThreshold(usage.usedPercent, settings.usageThresholdPercent);

    let signalled = false;
    if (overThreshold) {
      consumers = await measureConsumers();
      const last = await deps.lastSignalAt();
      const due = last === null || now().getTime() - last.getTime() >= signalIntervalMs;
      if (due) {
        await deps.logActivity({
          companyId: null as unknown as string,
          actorType: "system",
          actorId: "host-disk-sweep",
          agentId: null,
          runId: null,
          action: HOST_DISK_THRESHOLD_EXCEEDED_ACTION,
          entityType: "host_disk",
          entityId: usage.path,
          details: {
            usedPercent: usage.usedPercent,
            thresholdPercent: settings.usageThresholdPercent,
            usedGb: gigabytesFromBytes(usage.usedBytes),
            totalGb: gigabytesFromBytes(usage.totalBytes),
            freeGb: gigabytesFromBytes(usage.freeBytes),
            growthBytesPerHour,
            measuredPath: usage.path,
            consumers: consumers.map((c) => ({ path: c.path, sizeGb: gigabytesFromBytes(c.sizeBytes) })),
          },
        });
        signalled = true;
        deps.logger.info(
          { usedPercent: usage.usedPercent, thresholdPercent: settings.usageThresholdPercent },
          "host disk crossed the usage threshold",
        );
      }
    }

    const result: HostDiskSweepResult = {
      at: sample.measuredAt,
      measuredPath: usage.path,
      usedPercent: usage.usedPercent,
      usedBytes: usage.usedBytes,
      totalBytes: usage.totalBytes,
      freeBytes: usage.freeBytes,
      overThreshold,
      thresholdPercent: settings.usageThresholdPercent,
      growthBytesPerHour,
      consumers,
      signalled,
      error: null,
    };
    lastResult = result;
    return result;
  }

  async function measureConsumers(): Promise<HostDiskConsumerEntry[]> {
    const entries: HostDiskConsumerEntry[] = [];
    for (const directory of deps.consumerPaths) {
      const measurement = await measureConsumer(directory);
      entries.push({ path: directory, sizeBytes: measurement.sizeBytes });
    }
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
    return entries;
  }

  return {
    sweep,
    lastResult: () => lastResult,
    samples: () => ring.list(),
    consumers: () => [...consumers],
  };
}
