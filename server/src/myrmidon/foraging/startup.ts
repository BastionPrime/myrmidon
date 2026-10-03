// server/src/myrmidon/foraging/startup.ts
//
// myrmidon(1.6-FORAGE): the periodic sweep wiring. server/src/index.ts gets one
// marked call, `startForagingSweep(db)`, and one at shutdown; everything else
// lives here.
//
// Off by default: without `MYRMIDON_FORAGING_ENABLED=1` the function returns
// before anything is read — no timer, no query. On: one pass per company per
// interval (MYRMIDON_FORAGING_INTERVAL_SEC, default 3600), each company swept
// independently, so one company's failure is logged and does not stop the
// others, and the next tick tries again. A pass that overlaps the previous one
// waits: the timer skips a tick whose pass is still running instead of stacking.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { readForagingSettings } from "./settings.js";
import { foragingWiring } from "./index.js";

export interface ForagingSweepPorts {
  listCompanyIds(db: Db): Promise<string[]>;
  now(): Date;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

let stopRunning: (() => void) | null = null;

/** Starts the sweep; returns the stop function. A no-op when disabled. */
export function startForagingSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<ForagingSweepPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readForagingSettings(env);
  if (!settings.enabled) return () => {};
  const log = opts.ports?.log ?? logger;
  const wiring = foragingWiring(db, env);
  stopForagingSweep();

  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const companyIds = opts.ports?.listCompanyIds
        ? await opts.ports.listCompanyIds(db)
        : (await wiring.store.listCompanyIds());
      for (const companyId of companyIds) {
        try {
          await wiring.service.runPass(companyId);
        } catch (err) {
          log.warn({ err, companyId }, "foraging pass failed for one company");
        }
      }
    } catch (err) {
      log.error({ err }, "foraging sweep tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, settings.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void tick();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Stops the sweep started by `startForagingSweep`; a no-op when none runs. */
export function stopForagingSweep(): void {
  stopRunning?.();
}