// Maintenance mode (R3): optional Zabbix integration. Opening an instance window
// creates a Zabbix maintenance period for the configured host groups; closing it
// deletes the period. Off unless MYRMIDON_ZABBIX_URL, MYRMIDON_ZABBIX_TOKEN_REF and
// MYRMIDON_ZABBIX_HOST_GROUPS are all set. A Zabbix failure never blocks the mode:
// the hook throws, and the maintenance service logs it and carries on.

import { readFileSync } from "node:fs";
import type { MaintenanceWindow } from "./domain.js";
import type { MaintenanceHooks } from "./service.js";

export interface ZabbixSettings {
  url: string;
  tokenRef: string;
  hostGroups: string[];
  maxWindowSec: number;
  timeoutMs: number;
}

export function readZabbixSettings(env: NodeJS.ProcessEnv = process.env): ZabbixSettings | null {
  const url = env.MYRMIDON_ZABBIX_URL?.trim();
  const tokenRef = env.MYRMIDON_ZABBIX_TOKEN_REF?.trim();
  const hostGroups = (env.MYRMIDON_ZABBIX_HOST_GROUPS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!url || !tokenRef || hostGroups.length === 0) return null;
  const maxWindow = Number(env.MYRMIDON_ZABBIX_MAX_WINDOW_SEC?.trim() || 14_400);
  return {
    url,
    tokenRef,
    hostGroups,
    maxWindowSec: Number.isInteger(maxWindow) && maxWindow > 0 ? maxWindow : 14_400,
    timeoutMs: 10_000,
  };
}

/**
 * Resolve the token reference: `env:<NAME>` reads a variable, `file:<path>` reads a
 * file (a Docker secret, for example). The value is never logged.
 */
export function resolveZabbixToken(
  ref: string,
  deps: { env?: NodeJS.ProcessEnv; readFile?: (path: string) => string } = {},
): string {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let value: string | undefined;
  if (ref.startsWith("env:")) value = env[ref.slice(4)];
  else if (ref.startsWith("file:")) value = readFile(ref.slice(5));
  else throw new Error("MYRMIDON_ZABBIX_TOKEN_REF must be env:<NAME> or file:<path>");
  const token = value?.trim();
  if (!token) throw new Error("Zabbix API token reference resolved to an empty value");
  return token;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class ZabbixApiError extends Error {}

export function zabbixClient(settings: ZabbixSettings, deps: { fetch?: Fetch; token?: () => string } = {}) {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const token = deps.token ?? (() => resolveZabbixToken(settings.tokenRef));
  let requestId = 0;

  async function call<T>(method: string, params: unknown): Promise<T> {
    requestId += 1;
    let response: Response;
    try {
      response = await doFetch(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json-rpc",
          authorization: `Bearer ${token()}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: requestId }),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (err) {
      throw new ZabbixApiError(`Zabbix ${method} request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (!response.ok) throw new ZabbixApiError(`Zabbix ${method} returned HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as
      | { result?: T; error?: { code?: number; message?: string; data?: string } }
      | null;
    if (!body) throw new ZabbixApiError(`Zabbix ${method} returned a non-JSON body`);
    if (body.error) {
      throw new ZabbixApiError(
        `Zabbix ${method} error ${body.error.code ?? ""}: ${body.error.message ?? ""} ${body.error.data ?? ""}`.trim(),
      );
    }
    return body.result as T;
  }

  return {
    async createMaintenance(window: MaintenanceWindow, now: Date): Promise<string> {
      const groups = await call<Array<{ groupid: string; name: string }>>("hostgroup.get", {
        output: ["groupid", "name"],
        filter: { name: settings.hostGroups },
      });
      if (groups.length === 0) throw new ZabbixApiError("none of the configured Zabbix host groups exist");
      const since = Math.floor(now.getTime() / 1000);
      const result = await call<{ maintenanceids: string[] }>("maintenance.create", {
        // Zabbix requires unique names; the window id keeps them apart.
        name: `myrmidon: ${window.reason}`.slice(0, 100) + ` [${window.id.slice(0, 8)}]`,
        active_since: since,
        active_till: since + settings.maxWindowSec,
        maintenance_type: 0, // with data collection
        groups: groups.map((group) => ({ groupid: group.groupid })),
        timeperiods: [{ timeperiod_type: 0, start_date: since, period: settings.maxWindowSec }],
      });
      const id = result?.maintenanceids?.[0];
      if (!id) throw new ZabbixApiError("Zabbix maintenance.create returned no id");
      return String(id);
    },
    async deleteMaintenance(maintenanceId: string): Promise<void> {
      await call("maintenance.delete", [maintenanceId]);
    },
  };
}

/** Hooks for the maintenance service; empty (no calls at all) without settings. */
export function zabbixMaintenanceHooks(
  settings: ZabbixSettings | null,
  deps: { fetch?: Fetch; token?: () => string; now?: () => Date } = {},
): MaintenanceHooks {
  if (!settings) return {};
  const client = zabbixClient(settings, deps);
  const now = deps.now ?? (() => new Date());
  return {
    async onEntered(window) {
      // Only the instance window takes hosts out of monitoring.
      if (window.scope.type !== "instance") return;
      return { maintenanceId: await client.createMaintenance(window, now()), lastError: null };
    },
    async onExited(window) {
      if (window.scope.type !== "instance" || !window.zabbix?.maintenanceId) return;
      await client.deleteMaintenance(window.zabbix.maintenanceId);
    },
  };
}
