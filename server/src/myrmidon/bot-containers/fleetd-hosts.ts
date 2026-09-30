// server/src/myrmidon/bot-containers/fleetd-hosts.ts
//
// myrmidon(FLEETD-VMEXEC): named fleet hosts for bot placement. A container card
// may name a host (`adapterConfig.container.host`); the default host (no name)
// is the local docker driver. Each named host is a fleetd service entry:
//
//   MYRMIDON_FLEET_HOSTS='[
//     {"name":"vmexec","url":"http://fleetd.internal:9100","tokenSecret":"fleetd-vmexec-token"}
//   ]'
//
// The token is a company secret NAME, never a value: the board resolves it at
// startup (readCompanySecret), same as MYRMIDON_BOT_LLM_API_KEY_SECRET.
//
// Pure parsing and validation, no I/O: the entries feed fleetd-driver.ts and
// startup wiring, and the tests cover the shapes directly. Unknown keys are
// rejected, names are trimmed, duplicates are an error (a bot card naming a
// host must resolve to exactly one fleetd entry).

export const FLEET_HOSTS_ENV = "MYRMIDON_FLEET_HOSTS";

export interface FleetHostConfig {
  name: string;
  url: string;
  tokenSecret: string;
}

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFleetHosts(raw: string | undefined): Map<string, FleetHostConfig> {
  const hosts = new Map<string, FleetHostConfig>();
  const text = raw?.trim();
  if (!text) return hosts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${FLEET_HOSTS_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_HOSTS_ENV} must be a JSON array of host entries`);
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new Error(`${FLEET_HOSTS_ENV}: every entry must be an object`);
    const unknown = Object.keys(entry).filter((key) => key !== "name" && key !== "url" && key !== "tokenSecret");
    if (unknown.length > 0) throw new Error(`${FLEET_HOSTS_ENV}: unknown key "${unknown[0]}" (allowed: name, url, tokenSecret)`);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`${FLEET_HOSTS_ENV}: host name must match ${NAME_PATTERN} (got "${name}")`);
    }
    const url = typeof entry.url === "string" ? entry.url.trim().replace(/\/+$/, "") : "";
    if (!/^http:\/\//.test(url)) {
      throw new Error(`${FLEET_HOSTS_ENV}: host "${name}" url must be http:// (the fleetd listener lives on the internal network)`);
    }
    const tokenSecret = typeof entry.tokenSecret === "string" ? entry.tokenSecret.trim() : "";
    if (!tokenSecret) throw new Error(`${FLEET_HOSTS_ENV}: host "${name}" is missing tokenSecret (a company secret name)`);
    if (hosts.has(name)) throw new Error(`${FLEET_HOSTS_ENV}: duplicate host name "${name}"`);
    hosts.set(name, { name, url, tokenSecret });
  }
  return hosts;
}

/** The host a bot's card names; `null` is the default (local driver) host. */
export function cardFleetHost(card: { container?: unknown }): string | null {
  const container = isRecord(card.container) ? card.container : {};
  const host = container.host;
  if (host === undefined || host === null) return null;
  if (typeof host !== "string" || !NAME_PATTERN.test(host.trim())) {
    throw new Error(`container.host must be a host name matching ${NAME_PATTERN} (got ${JSON.stringify(host)})`);
  }
  const trimmed = host.trim();
  if (trimmed === "local") throw new Error('container.host "local" is not a host: omit container.host for the local driver');
  return trimmed;
}
