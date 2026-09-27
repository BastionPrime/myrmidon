/**
 * myrmidon(S2): build the environment of an agent run process from an allow
 * list instead of inheriting the whole server environment.
 *
 * A run process gets exactly three sources:
 *   1. base variables from the server environment that are on the allow list
 *      (PATH, HOME, locale, proxy, CA bundle, ...), extended by the
 *      `MYRMIDON_RUN_ENV_ALLOW` setting;
 *   2. the agent's `adapterConfig.env` (already resolved by the server,
 *      including secrets bound to the agent);
 *   3. run variables set by the server for this run (`PAPERCLIP_*`).
 *
 * Everything else from the server environment (database URL, auth and
 * signing secrets, cloud keys, server-level model provider keys) is dropped.
 * The per-agent flag `adapterConfig.inheritProcessEnv: true` restores the
 * vendor behaviour.
 */

/** Setting with extra variable names (comma separated, names only). */
export const MYRMIDON_RUN_ENV_ALLOW_SETTING = "MYRMIDON_RUN_ENV_ALLOW";

/** Base variables a run inherits from the server environment. */
export const MYRMIDON_RUN_ENV_BASE_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TERM",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  // Windows needs these to start any process at all.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
];

/** Prefixes of base variables a run inherits (locale categories). */
export const MYRMIDON_RUN_ENV_BASE_ALLOW_PREFIXES: readonly string[] = ["LC_"];

/**
 * Non-secret server runtime pointers the vendor deliberately keeps in the
 * inherited environment (see `sanitizeInheritedPaperclipEnv`).
 */
export const MYRMIDON_RUN_ENV_VENDOR_RUNTIME_KEYS: readonly string[] = [
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
];

export interface MyrmidonInheritedEnvOptions {
  /** Restore vendor behaviour: inherit the whole server environment. */
  inheritProcessEnv?: boolean;
  /** Extra allowed names; defaults to the `MYRMIDON_RUN_ENV_ALLOW` setting. */
  extraAllow?: readonly string[];
  /** Receives the names (never values) of dropped variables. */
  onDropped?: (names: string[]) => void;
}

export interface MyrmidonRunEnvInput extends MyrmidonInheritedEnvOptions {
  /** Server environment; defaults to `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Resolved `adapterConfig.env` of the agent. */
  adapterEnv?: Record<string, string | undefined> | null;
  /** Variables the server sets for this run (`PAPERCLIP_*`). */
  runEnv?: Record<string, string | undefined> | null;
}

/** Parse a comma separated list of variable names. */
export function parseRunEnvAllowList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

function readExtraAllowFromSetting(): string[] {
  return parseRunEnvAllowList(process.env[MYRMIDON_RUN_ENV_ALLOW_SETTING]);
}

function buildAllowSet(extraAllow: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const name of MYRMIDON_RUN_ENV_BASE_ALLOW) {
    allowed.add(name);
    allowed.add(name.toLowerCase());
  }
  for (const name of MYRMIDON_RUN_ENV_VENDOR_RUNTIME_KEYS) allowed.add(name);
  for (const name of extraAllow) allowed.add(name);
  return allowed;
}

export function isMyrmidonRunEnvAllowedKey(
  key: string,
  extraAllow: readonly string[] = readExtraAllowFromSetting(),
): boolean {
  return makeAllowCheck(extraAllow)(key);
}

function makeAllowCheck(extraAllow: readonly string[]): (key: string) => boolean {
  const allowed = buildAllowSet(extraAllow);
  return (key) =>
    allowed.has(key) ||
    // Windows keeps mixed case names (SystemRoot, windir, ComSpec).
    (process.platform === "win32" && allowed.has(key.toUpperCase())) ||
    MYRMIDON_RUN_ENV_BASE_ALLOW_PREFIXES.some(
      (prefix) => key.startsWith(prefix) || key.startsWith(prefix.toLowerCase()),
    );
}

/**
 * `adapterConfig.inheritProcessEnv` is honoured only when it is literally
 * `true`; strings such as "true" do not count.
 */
export function readInheritProcessEnvFlag(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  return (config as Record<string, unknown>).inheritProcessEnv === true;
}

const reportedDroppedNames = new Set<string>();

/**
 * Default report of dropped names: debug line with names only, each name
 * reported once per server process so busy instances do not flood the log.
 */
export function reportDroppedRunEnvNames(names: string[]): void {
  const fresh = names.filter((name) => !reportedDroppedNames.has(name));
  if (fresh.length === 0) return;
  for (const name of fresh) reportedDroppedNames.add(name);
  console.debug(
    `[myrmidon] run env: server variables not passed to agent runs: ${fresh.sort().join(", ")}`,
  );
}

/** Test helper: forget which dropped names were already reported. */
export function resetReportedDroppedRunEnvNames(): void {
  reportedDroppedNames.clear();
}

/**
 * The part of the server environment a run inherits. Replaces
 * `sanitizeInheritedPaperclipEnv(process.env)` at spawn time.
 */
export function filterMyrmidonInheritedEnv(
  processEnv: NodeJS.ProcessEnv,
  options: MyrmidonInheritedEnvOptions = {},
): NodeJS.ProcessEnv {
  if (options.inheritProcessEnv === true) {
    // Vendor behaviour: everything except the server's own PAPERCLIP_* vars.
    const env: NodeJS.ProcessEnv = { ...processEnv };
    delete env.PAPERCLIPAI_CMD;
    for (const key of Object.keys(env)) {
      if (!key.startsWith("PAPERCLIP_")) continue;
      if (MYRMIDON_RUN_ENV_VENDOR_RUNTIME_KEYS.includes(key)) continue;
      delete env[key];
    }
    return env;
  }

  const isAllowed = makeAllowCheck(options.extraAllow ?? readExtraAllowFromSetting());
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (isAllowed(key)) {
      env[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) (options.onDropped ?? reportDroppedRunEnvNames)(dropped);
  return env;
}

/**
 * Full environment of a run process: allowed base variables, then the
 * agent's `adapterConfig.env`, then the run's own variables.
 */
export function buildMyrmidonRunEnv(input: MyrmidonRunEnvInput): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    ...filterMyrmidonInheritedEnv(input.processEnv ?? process.env, input),
    ...(input.adapterEnv ?? {}),
    ...(input.runEnv ?? {}),
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
