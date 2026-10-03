// server/src/myrmidon/telegram-notify/sweep.ts
//
// myrmidon(1.6-TG-NOTIFY-C): the periodic pass that keeps the errors channel
// current. Modelled on the tracing-health signal sweep: a timer tick calls
// sweepErrorChannel for every active company; a disabled channel answers
// zero work. The interval is an environment knob with clamps, read once at
// startup (a settings change re-reads on the next tick through the settings
// source; the timer cadence itself stays fixed).
//
// Wiring: server/src/index.ts starts it next to the other myrmidon sweeps
// with a myrmidon(1.6-TG-NOTIFY-C) marker; it is a no-op unless at least
// one company has the channel enabled (the per-company early return).

import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { attentionService } from "../../services/attention.js";
import {
  HourlyRateLimiter,
  sweepErrorChannel,
  type ErrorChannelSettingsSource,
  type ErrorChannelSweepResult,
} from "./errors.js";

export const TG_NOTIFY_SWEEP_INTERVAL_SEC_ENV = "MYRMIDON_TG_NOTIFY_INTERVAL_SEC";
const DEFAULT_SWEEP_INTERVAL_SEC = 300;
const MIN_SWEEP_INTERVAL_SEC = 60;
const MAX_SWEEP_INTERVAL_SEC = 86400;

export function readTgNotifySweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TG_NOTIFY_SWEEP_INTERVAL_SEC_ENV]?.trim();
  if (!raw) return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SWEEP_INTERVAL_SEC || value > MAX_SWEEP_INTERVAL_SEC) {
    return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

export interface TgNotifySweepDeps {
  db: Db;
  /** Settings source: part A's store in production, memory in tests. */
  settings: ErrorChannelSettingsSource;
  now?(): Date;
}

/**
 * One full pass: every active company, one sweepErrorChannel each. A
 * company whose channel is off costs one settings read; a failure of one
 * company's sweep is logged and does not stop the others.
 */
export async function tgNotifySweepAll(deps: TgNotifySweepDeps): Promise<{
  companies: number;
  sent: number;
  droppedRateLimited: number;
}> {
  const rows = await deps.db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"));
  const limiter = new HourlyRateLimiter(deps.now);
  let sent = 0;
  let dropped = 0;
  let visited = 0;
  for (const row of rows) {
    try {
      const result: ErrorChannelSweepResult = await sweepErrorChannel(row.id, {
        db: deps.db,
        settings: deps.settings,
        feed: {
          list: (companyId: string) =>
            attentionService(deps.db).list(companyId, {
              includeDismissed: false,
              all: true,
              allowUnscopedAll: true,
            })
              .then((feed) => feed.items),
        },
        limiter,
      });
      sent += result.sent;
      dropped += result.droppedRateLimited;
      visited += 1;
    } catch (error) {
      logger.error({ err: error, companyId: row.id }, "telegram-notify errors sweep failed for company");
    }
  }
  return { companies: visited, sent, droppedRateLimited: dropped };
}

let stopRunning: (() => void) | null = null;

/**
 * Start the periodic errors-channel sweep. Returns the stop function. The
 * timer is unref'd so tests and CLI boots exit cleanly. The sweep itself is
 * fully off unless a company's settings enable it, so starting the timer is
 * always safe.
 */
export function startTgNotifySweep(deps: TgNotifySweepDeps & { env?: NodeJS.ProcessEnv }): () => void {
  const env = deps.env ?? process.env;
  const intervalMs = readTgNotifySweepIntervalMs(env);
  const timer = setInterval(() => {
    void tgNotifySweepAll(deps).catch((err) => {
      logger.error({ err }, "telegram-notify errors sweep tick failed");
    });
  }, intervalMs);
  timer.unref?.();
  stopRunning = () => clearInterval(timer);
  return stopRunning;
}

/** Stop the sweep (idempotent). */
export function stopTgNotifySweep(): void {
  stopRunning?.();
  stopRunning = null;
}