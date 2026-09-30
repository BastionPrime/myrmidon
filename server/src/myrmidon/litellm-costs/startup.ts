// server/src/myrmidon/litellm-costs/startup.ts
//
// myrmidon(M2-A): the periodic sweep wiring. server/src/index.ts gets one
// marked call, `startLitellmCostSweep(db)`, next to startBotContainers, and
// one at shutdown; everything else lives here.
//
// Off (either setting unset — the default): returns before anything is read;
// no timer, no query. On: one sweep per company per interval
// (MYRMIDON_LITELLM_COST_INTERVAL_SEC, default 300), each company swept
// independently — a failure of one company's sweep is logged and does not
// stop the others, and the next tick tries again. A sweep that overlaps the
// previous one (slow gateway) waits: the timer skips a tick whose sweep is
// still running instead of stacking them.

import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/index.js";
import { createLitellmGatewayClient, readLitellmCostSettings, sweepLitellmCosts } from "./litellm-costs.js";
import { listGatewayBotKeys } from "./bot-keys.js";

export interface LitellmSweepPorts {
  listCompanyIds(db: Db): Promise<string[]>;
  readGatewayKey(db: Db, companyId: string, secretName: string): Promise<string | null>;
  now(): Date;
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void; error(fields: object, message: string): void };
}

const defaultPorts: LitellmSweepPorts = {
  async listCompanyIds(db) {
    const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
    return rows.map((row) => row.id);
  },
  async readGatewayKey(db, companyId, secretName) {
    const secrets = secretService(db);
    const row = await secrets.getByName(companyId, secretName);
    if (!row) return null;
    return secrets.resolveSecretValue(companyId, row.id, "latest");
  },
  now: () => new Date(),
  log: logger,
};

let stopRunning: (() => void) | null = null;

/** Starts the sweep; returns the stop function. A no-op when disabled. */
export function startLitellmCostSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<LitellmSweepPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readLitellmCostSettings(env);
  if (!settings.enabled) return () => {};
  const ports: LitellmSweepPorts = { ...defaultPorts, ...opts.ports };
  stopLitellmCostSweep();

  let sweeping = false;
  let stopped = false;
  const tick = async () => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const companyIds = await ports.listCompanyIds(db);
      for (const companyId of companyIds) {
        try {
          await sweepLitellmCosts(
            {
              db,
              readGatewayKey: (id, name) => ports.readGatewayKey(db, id, name),
              listBotKeys: (id) => listGatewayBotKeys(db, id, env),
              client: createLitellmGatewayClient,
              now: ports.now,
              log: ports.log,
            },
            companyId,
            settings,
          );
        } catch (err) {
          ports.log.warn({ err, companyId }, "litellm cost sweep failed for one company");
        }
      }
    } catch (err) {
      ports.log.error({ err }, "litellm cost sweep tick failed");
    } finally {
      sweeping = false;
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

/** Stops the sweep started by `startLitellmCostSweep`; a no-op when none runs. */
export function stopLitellmCostSweep(): void {
  stopRunning?.();
}
