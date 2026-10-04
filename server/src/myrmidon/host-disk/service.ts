import {
  HOST_DISK_LIMIT_KEYS,
  HOST_DISK_UPDATED_ACTION,
  mergeHostDiskSettings,
  resolveHostDiskSettings,
  type HostDiskSettings,
  type HostDiskSettingsPatch,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import type { HostDiskSweepResult } from "./state.js";

/**
 * Read and change the host disk threshold without a restart (myrmidon
 * BOT-DISK, part E).
 *
 * Contract: `instance_settings.general.hostDisk` is the source of truth once
 * an operator saves it; the environment stays the first-start default. The
 * sweep re-reads the threshold at the top of every measurement, so the next
 * tick already uses the new value — the same contract the workspace quotas
 * follow.
 */

export interface HostDiskActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export interface HostDiskStatusView {
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
}

export interface HostDiskView {
  threshold: {
    usageThresholdPercent: number;
    sources: { usageThresholdPercent: HostDiskLimitSource };
  };
  status: HostDiskStatusView;
}

type HostDiskLimitSource = "settings" | "env" | "default";

export interface HostDiskGeneralSettings {
  hostDisk?: unknown;
}

export interface HostDiskServiceDeps {
  settings: {
    getGeneral(): Promise<HostDiskGeneralSettings>;
    updateGeneral(patch: { hostDisk: HostDiskSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: LogActivityInput): Promise<unknown>;
  lastSignalAt(): Promise<Date | null>;
  lastSweep?: () => HostDiskSweepResult | null;
  env?: Record<string, string | undefined>;
}

export interface HostDiskService {
  read(): Promise<HostDiskView>;
  update(patch: HostDiskSettingsPatch, actor: HostDiskActor): Promise<HostDiskView>;
}

let hostDiskTransitionQueue: Promise<void> = Promise.resolve();

function withHostDiskTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = hostDiskTransitionQueue.then(run);
  hostDiskTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function hostDiskService(deps: HostDiskServiceDeps): HostDiskService {
  const env = deps.env ?? process.env;

  async function read(): Promise<HostDiskView> {
    const general = await deps.settings.getGeneral();
    const resolved = resolveHostDiskSettings({ stored: general.hostDisk, env });
    const lastSweep = deps.lastSweep?.() ?? null;
    const lastSignalAt = await deps.lastSignalAt();
    const sweep = lastSweep;
    return {
      threshold: {
        usageThresholdPercent: resolved.settings.usageThresholdPercent,
        sources: resolved.sources,
      },
      status: {
        usage: {
          measuredPath: sweep?.measuredPath ?? null,
          usedPercent: sweep?.usedPercent ?? null,
          usedGb: sweep?.usedPercent !== null && sweep?.usedBytes !== null && sweep?.totalBytes
            ? Math.round((sweep.usedBytes ?? 0) / (1024 * 1024 * 1024))
            : null,
          totalGb: sweep?.totalBytes ? Math.round(sweep.totalBytes / (1024 * 1024 * 1024)) : null,
          freeGb: sweep?.freeBytes ? Math.round((sweep.freeBytes ?? 0) / (1024 * 1024 * 1024)) : null,
          growthBytesPerHour: sweep?.growthBytesPerHour ?? null,
          measuredAt: sweep?.at ?? null,
        },
        consumers: (sweep?.consumers ?? []).map((c) => ({
          path: c.path,
          sizeGb: Math.round(c.sizeBytes / (1024 * 1024 * 1024)),
        })),
        overThreshold: sweep?.overThreshold ?? false,
        lastSweepAt: sweep?.at ?? null,
        lastSignalAt: lastSignalAt ? lastSignalAt.toISOString() : null,
      },
    };
  }

  return {
    read,

    update: (patch, actor) =>
      withHostDiskTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveHostDiskSettings({ stored: general.hostDisk, env });
        const next = mergeHostDiskSettings(before.settings, patch);
        const changedKeys = HOST_DISK_LIMIT_KEYS.filter(
          (key) => before.settings[key] !== next[key],
        );

        await deps.settings.updateGeneral({ hostDisk: next });

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: HOST_DISK_UPDATED_ACTION,
              entityType: "instance_settings",
              entityId: "host-disk",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { threshold: next, changedKeys, actorType: actor.actorType },
          "host disk threshold updated without a restart",
        );
        return read();
      }),
  };
}
