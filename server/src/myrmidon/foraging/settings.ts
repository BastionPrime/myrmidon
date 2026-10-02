// server/src/myrmidon/foraging/settings.ts
//
// myrmidon(1.6-FORAGE): where the FORAGING sweep gets its switch, its period,
// its per-pass budget and the name of the company secret it reads with.
//
// Off by default: the sweep only starts when the instance explicitly enables it
// (`MYRMIDON_FORAGING_ENABLED=1`), the same shape the other myrmidon sweeps use
// for a feature that talks to the outside world. Nothing is read, no timer is
// armed and no source is fetched while the switch is off.
//
// The key is named, never carried: `MYRMIDON_FORAGING_KEY_SECRET` holds the NAME
// of a company secret whose value is sent as a bearer token to the source. The
// value is read from the company's secrets at call time and never logged.

import {
  DEFAULT_FORAGING_BUDGET_CENTS,
  DEFAULT_FORAGING_INTERVAL_SEC,
  FORAGING_BUDGET_CENTS_ENV,
  FORAGING_INTERVAL_SEC_ENV,
  FORAGING_KEY_SECRET_ENV,
  type ForagingBudget,
} from "./domain.js";

export const FORAGING_ENABLED_ENV = "MYRMIDON_FORAGING_ENABLED";
export { FORAGING_BUDGET_CENTS_ENV, FORAGING_INTERVAL_SEC_ENV, FORAGING_KEY_SECRET_ENV };
export const FORAGING_MIN_HOST_INTERVAL_SEC_ENV = "MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC";

const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86_400;
const DEFAULT_MIN_HOST_INTERVAL_SEC = 60;
const MIN_HOST_INTERVAL_FLOOR_SEC = 5;

export interface ForagingSettings {
  /** The sweep runs only while this is true. */
  enabled: boolean;
  intervalMs: number;
  /** The per-pass cost ceiling; `enabled: false` means "no limit". */
  budget: ForagingBudget;
  /** Name of the company secret carrying the read token, or null. */
  keySecret: string | null;
  /** The smallest pause between two reads of the same host, in milliseconds. */
  minHostIntervalMs: number;
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

/** The switch is opt-in on the exact value `1`; any other value keeps it off. */
export function readForagingSettings(env: NodeJS.ProcessEnv = process.env): ForagingSettings {
  const enabled = env[FORAGING_ENABLED_ENV] === "1";
  const intervalSec = readInt(
    env[FORAGING_INTERVAL_SEC_ENV],
    DEFAULT_FORAGING_INTERVAL_SEC,
    MIN_INTERVAL_SEC,
    MAX_INTERVAL_SEC,
  );
  const budgetRaw = env[FORAGING_BUDGET_CENTS_ENV]?.trim();
  let maxCostCents = DEFAULT_FORAGING_BUDGET_CENTS;
  let budgetEnabled = true;
  if (budgetRaw !== undefined && budgetRaw !== "") {
    const value = Number(budgetRaw);
    if (Number.isFinite(value) && value > 0) {
      maxCostCents = Math.floor(value);
    } else {
      // A configured zero or a negative number is the explicit "no limit".
      budgetEnabled = false;
      maxCostCents = 0;
    }
  }
  const minHostIntervalSec = readInt(
    env[FORAGING_MIN_HOST_INTERVAL_SEC_ENV],
    DEFAULT_MIN_HOST_INTERVAL_SEC,
    MIN_HOST_INTERVAL_FLOOR_SEC,
    MAX_INTERVAL_SEC,
  );
  const keySecret = env[FORAGING_KEY_SECRET_ENV]?.trim() || null;
  return {
    enabled,
    intervalMs: intervalSec * 1000,
    budget: { maxCostCents, enabled: budgetEnabled },
    keySecret,
    minHostIntervalMs: minHostIntervalSec * 1000,
  };
}