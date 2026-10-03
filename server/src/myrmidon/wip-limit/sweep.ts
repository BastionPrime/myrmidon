// server/src/myrmidon/wip-limit/sweep.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the periodic WIP check.
//
// One pass per interval per company: read the settings (a missing limit means
// "count only", so the pass stops before any query when no limit is set),
// compute the status, deliver one deduped signal comment per over-limit agent.
// The attention feed needs no sweep of its own — it recomputes on every list.
//
// The interval is in-module (the same shape the swarm-claim sweep uses); a
// pass whose previous run is still going is skipped, not queued.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import type { Logger } from "pino";
import { logger } from "../../middleware/logger.js";
import { readWipLimitSettings, type WipLimitSettingsService } from "./settings.js";
import { buildWipLimitStatus } from "./status.js";
import { deliverWipLimitSignal, type WipLimitSignalPorts } from "./signal.js";

export const DEFAULT_WIP_LIMIT_SWEEP_INTERVAL_SEC = 300;
export const MIN_WIP_LIMIT_SWEEP_INTERVAL_SEC = 30;
export const MAX_WIP_LIMIT_SWEEP_INTERVAL_SEC = 3600;

export interface WipLimitSweepResult {
  /** True when the pass was skipped before scanning (interval or no limit). */
  skipped: boolean;
  inspected: number;
  signaled: number;
  failed: number;
}

export interface WipLimitSweeperDeps {
  db: Db;
  settings: WipLimitSettingsService;
  addComment: WipLimitSignalPorts["addComment"];
  intervalMs?: number;
  now?(): Date;
  log?: Pick<Logger, "info" | "warn">;
}

export interface WipLimitSweeper {
  resetForTest(): void;
  sweep(now?: Date, options?: { force?: boolean }): Promise<WipLimitSweepResult>;
}

/** True when no limit of the settings can ever signal (all null / empty). */
export function wipLimitsAllDisabled(
  settings: { defaultLimit: number | null; perAgent: Record<string, number | null> },
): boolean {
  if (settings.defaultLimit !== null) return false;
  for (const value of Object.values(settings.perAgent)) {
    if (value !== null) return false;
  }
  return true;
}

export function createWipLimitSweeper(deps: WipLimitSweeperDeps): WipLimitSweeper {
  const intervalMs = deps.intervalMs ?? DEFAULT_WIP_LIMIT_SWEEP_INTERVAL_SEC * 1000;
  const log = deps.log ?? logger;
  let lastSweepAtMs = 0;

  async function sweepCompany(companyId: string, result: WipLimitSweepResult): Promise<void> {
    const settings = await readWipLimitSettings(deps.settings);
    if (wipLimitsAllDisabled(settings)) return;
    const statuses = await buildWipLimitStatus(deps.db, companyId, settings);
    const overLimit = statuses.filter((status) => status.overLimit);
    result.inspected += statuses.length;
    if (overLimit.length === 0) return;
    const nameRows = await deps.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const nameById = new Map(nameRows.map((row) => [row.id, row.name] as const));
    for (const status of overLimit) {
      const outcome = await deliverWipLimitSignal(deps.db, {
        addComment: deps.addComment,
        now: deps.now ?? (() => new Date()),
      }, {
        companyId,
        status,
        agentName: nameById.get(status.agentId) ?? null,
      });
      if (outcome.written) result.signaled += 1;
    }
  }

  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = new Date(), options) {
      const result: WipLimitSweepResult = { skipped: false, inspected: 0, signaled: 0, failed: 0 };
      if (!options?.force && now.getTime() - lastSweepAtMs < intervalMs) {
        result.skipped = true;
        return result;
      }
      lastSweepAtMs = now.getTime();

      const companyRows = await deps.db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.status, "active")));
      for (const company of companyRows) {
        try {
          await sweepCompany(company.id, result);
        } catch (err) {
          result.failed += 1;
          log.warn({ err, companyId: company.id }, "WIP limit sweep failed for one company");
        }
      }
      if (result.signaled > 0 || result.failed > 0) {
        log.info(result, "WIP limit sweep completed");
      }
      return result;
    },
  };
}
