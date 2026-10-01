// server/src/myrmidon/bot-containers/fleetd-hosts.ts
//
// myrmidon(FLEETD-VMEXEC): named fleet hosts for bot placement. A container card
// may name a host (`adapterConfig.container.host`); the default host (no name)
// is the local docker driver. Each named host is a fleetd service entry:
//
//   MYRMIDON_FLEET_HOSTS='[
//     {"name":"vmexec","url":"http://fleetd.internal:9100","tokenSecret":"fleetd-vmexec-token",
//      "hindsightUrl":"http://hindsight.internal:8890","llmBaseUrl":"http://llm.internal:4000",
//      "boardExtraHost":"paperclip-server-1","volumeRoot":"/srv/myrmidon-bots",
//      "network":"myrmidon-bots","imageAllowlist":["ghcr.io/example/bot@sha256:*"]}
//   ]'
//
// The token is a company secret NAME, never a value: the board resolves it at
// startup (readCompanySecret), same as MYRMIDON_BOT_LLM_API_KEY_SECRET.
//
// The remaining fields exist because the instance-wide settings
// (MYRMIDON_BOT_HINDSIGHT_API_URL, MYRMIDON_BOT_LLM_BASE_URL, the bind address
// the bot container resolves the board by, the volume root, the bot network and
// the image allowlist) describe the machine the BOARD runs on. A bot on a second
// machine reaches a different address for each of them, so an entry may override
// any of them for its own host; an omitted field falls back to the instance-wide
// value, and the local driver keeps using the instance-wide value unchanged.
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
  /** Hindsight base URL as seen FROM THIS HOST (`http://…`); instance-wide value when omitted. */
  hindsightUrl?: string;
  /** LLM gateway base URL as seen from this host (`http://…`); instance-wide value when omitted. */
  llmBaseUrl?: string;
  /** Name the bot container on this host resolves the board by (docker `--add-host`
   *  target). The instance-wide board URL name by default; the board's own
   *  hostname allowlist is never widened by this field. */
  boardExtraHost?: string;
  /** Directory the host's fleetd keeps bot volumes under. */
  volumeRoot?: string;
  /** Docker network the host's bot containers join. */
  network?: string;
  /** Image allowlist (globs) enforced by the host's fleetd; instance-wide list when omitted. */
  imageAllowlist?: readonly string[];
}

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** A DNS name a container may resolve: labels of the same shape, dot-separated. */
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const ALLOWED_KEYS = new Set([
  "name",
  "url",
  "tokenSecret",
  "hindsightUrl",
  "llmBaseUrl",
  "boardExtraHost",
  "volumeRoot",
  "network",
  "imageAllowlist",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(entry: Record<string, unknown>, key: string, host: string): string | undefined {
  const raw = entry[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`${FLEET_HOSTS_ENV}: host "${host}" field "${key}" must be a string`);
  }
  const value = raw.trim();
  if (!value) throw new Error(`${FLEET_HOSTS_ENV}: host "${host}" field "${key}" is empty`);
  return value;
}

function optionalHttpUrl(entry: Record<string, unknown>, key: string, host: string): string | undefined {
  const value = optionalString(entry, key, host);
  if (value === undefined) return undefined;
  if (!/^http:\/\//.test(value)) {
    throw new Error(
      `${FLEET_HOSTS_ENV}: host "${host}" field "${key}" must be http:// (it is reachable from the internal network only)`,
    );
  }
  return value.replace(/\/+$/, "");
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
    const unknown = Object.keys(entry).filter((key) => !ALLOWED_KEYS.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `${FLEET_HOSTS_ENV}: unknown key "${unknown[0]}" (allowed: ${Array.from(ALLOWED_KEYS).join(", ")})`,
      );
    }
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

    const boardExtraHost = optionalString(entry, "boardExtraHost", name);
    if (boardExtraHost !== undefined && !HOSTNAME_PATTERN.test(boardExtraHost)) {
      throw new Error(`${FLEET_HOSTS_ENV}: host "${name}" field "boardExtraHost" must be a hostname (got "${boardExtraHost}")`);
    }
    const volumeRoot = optionalString(entry, "volumeRoot", name);
    if (volumeRoot !== undefined && !volumeRoot.startsWith("/")) {
      throw new Error(`${FLEET_HOSTS_ENV}: host "${name}" field "volumeRoot" must be an absolute path`);
    }
    const network = optionalString(entry, "network", name);

    let imageAllowlist: readonly string[] | undefined;
    if (entry.imageAllowlist !== undefined && entry.imageAllowlist !== null) {
      if (!Array.isArray(entry.imageAllowlist) || entry.imageAllowlist.some((x) => typeof x !== "string")) {
        throw new Error(`${FLEET_HOSTS_ENV}: host "${name}" field "imageAllowlist" must be an array of strings`);
      }
      imageAllowlist = (entry.imageAllowlist as string[]).map((x) => x.trim()).filter((x) => x.length > 0);
    }

    const host: FleetHostConfig = { name, url, tokenSecret };
    const hindsightUrl = optionalHttpUrl(entry, "hindsightUrl", name);
    if (hindsightUrl !== undefined) host.hindsightUrl = hindsightUrl;
    const llmBaseUrl = optionalHttpUrl(entry, "llmBaseUrl", name);
    if (llmBaseUrl !== undefined) host.llmBaseUrl = llmBaseUrl;
    if (boardExtraHost !== undefined) host.boardExtraHost = boardExtraHost;
    if (volumeRoot !== undefined) host.volumeRoot = volumeRoot;
    if (network !== undefined) host.network = network;
    if (imageAllowlist !== undefined) host.imageAllowlist = imageAllowlist;
    hosts.set(name, host);
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