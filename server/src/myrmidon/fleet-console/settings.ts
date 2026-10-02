// myrmidon(SC1): settings of the panel's browser console.
//
// The console needs one operator-supplied value: the base URL of the Guacamole
// client that this panel signs auth-JSON for. It has no neutral default, so an
// instance that has not configured it refuses to hand out console tokens
// instead of pointing the browser at a guess. Documented in
// docs/myrmidon/SETTINGS.md.

/** Base URL of the Guacamole client (for example `https://guac.example.com/`). */
export const FLEET_CONSOLE_URL_ENV = "MYRMIDON_FLEET_CONSOLE_URL";

/**
 * Name of the company secret that holds the shared `json-secret-key` of the
 * Guacamole client. The value stays in the panel secret store: it is read on
 * the server, used to sign, and never sent to the browser.
 */
export const FLEET_CONSOLE_SECRET_KEY_NAME = "guacamole-json-secret-key";

/** Lifetime of an issued console token, in milliseconds. */
export const FLEET_CONSOLE_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface FleetConsoleSettings {
  /** `null` when the instance has not configured the Guacamole client URL. */
  guacamoleUrl: string | null;
  secretKeyName: string;
  tokenTtlMs: number;
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function readFleetConsoleSettings(env: NodeJS.ProcessEnv = process.env): FleetConsoleSettings {
  return {
    guacamoleUrl: normalizeBaseUrl(env[FLEET_CONSOLE_URL_ENV]),
    secretKeyName: FLEET_CONSOLE_SECRET_KEY_NAME,
    tokenTtlMs: FLEET_CONSOLE_TOKEN_TTL_MS,
  };
}