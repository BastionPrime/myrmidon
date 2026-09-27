/**
 * myrmidon(S5): mask secret values in text that is stored or leaves the
 * server (run events and logs, run results, agent comments, outgoing chat
 * messages).
 *
 * Two layers:
 *   - value based: the actual values of secrets this server knows about —
 *     server secrets (the S2 list, server-level provider keys, the database
 *     password) and the resolved secret env of every agent run started by this
 *     process. A value becomes `[secret:<NAME>]`. Values shorter than 8
 *     characters are never masked, so ordinary words survive;
 *   - pattern based: credentials inside URLs and connection strings
 *     (`scheme://user:password@host`, token-only userinfo in git URLs) become
 *     `****`, whatever their length.
 *
 * The vendor text redaction (`redactSensitiveText`) calls `maskSecretsInText`,
 * so every place that already redacts text gets both layers.
 */

export const SECRET_MASK_MIN_LENGTH = 8;
export const URL_CREDENTIAL_MASK = "****";

/** Server secrets that never reach a run (S2) and are masked everywhere. */
export const SERVER_SECRET_ENV_NAMES: readonly string[] = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

/** Server-level provider keys and other credential-shaped variable names. */
const SERVER_SECRET_NAME_RE = /(?:_API_KEY|_SECRET|_SECRET_KEY|_TOKEN|_PASSWORD|_PASSWD)$/;

type MaskEntry = { name: string; value: string };

/** Resolved secret values seen by this process: value -> env name. */
const registeredSecretValues = new Map<string, string>();
/** Bound on remembered values; the oldest are forgotten first. */
export const MAX_REGISTERED_SECRET_VALUES = 5000;
let serverEntries: MaskEntry[] | null = null;
let compiled: { re: RegExp; names: Map<string, string> } | null | undefined;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= SECRET_MASK_MIN_LENGTH;
}

/** Password of a URL-shaped connection string, raw and decoded. */
export function connectionStringPasswords(value: string): string[] {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/i.exec(value.trim());
  if (!match?.[1]) return [];
  const raw = match[1];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw form only.
  }
  return [...new Set([raw, decoded])];
}

function collectServerEntries(env: NodeJS.ProcessEnv): MaskEntry[] {
  const entries: MaskEntry[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!maskable(value)) continue;
    if (!SERVER_SECRET_ENV_NAMES.includes(name) && !SERVER_SECRET_NAME_RE.test(name)) continue;
    entries.push({ name, value });
  }
  for (const password of connectionStringPasswords(env.DATABASE_URL ?? "")) {
    if (maskable(password)) entries.push({ name: "DATABASE_URL", value: password });
  }
  return entries;
}

function allEntries(): MaskEntry[] {
  serverEntries ??= collectServerEntries(process.env);
  return [
    ...serverEntries,
    ...[...registeredSecretValues].map(([value, name]) => ({ name, value })),
  ];
}

function compile() {
  if (compiled !== undefined) return compiled;
  const names = new Map<string, string>();
  for (const entry of allEntries()) {
    if (!names.has(entry.value)) names.set(entry.value, entry.name);
  }
  if (names.size === 0) {
    compiled = null;
    return compiled;
  }
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  compiled = { re: new RegExp(alternatives.join("|"), "g"), names };
  return compiled;
}

/**
 * Remember resolved secret values (agent, environment, project and routine
 * secret bindings) so they are masked wherever text is redacted. Only keys
 * that came from secret bindings are taken; plain config values are not
 * secrets. Values stay remembered after rotation, so older outputs that
 * still carry them are masked too.
 */
export function registerSecretValues(env: unknown, secretKeys: Iterable<string>): void {
  if (typeof env !== "object" || env === null) return;
  const record = env as Record<string, unknown>;
  let changed = false;
  const remember = (name: string, value: string) => {
    if (!maskable(value)) return;
    if (registeredSecretValues.get(value) === name) return;
    registeredSecretValues.delete(value);
    registeredSecretValues.set(value, name);
    changed = true;
  };
  for (const key of secretKeys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    remember(key, value);
    for (const password of connectionStringPasswords(value)) remember(key, password);
  }
  while (registeredSecretValues.size > MAX_REGISTERED_SECRET_VALUES) {
    const oldest = registeredSecretValues.keys().next().value;
    if (oldest === undefined) break;
    registeredSecretValues.delete(oldest);
  }
  if (changed) compiled = undefined;
}

/** Test helper: forget registered values and re-read the server env. */
export function resetSecretMasking(): void {
  registeredSecretValues.clear();
  serverEntries = null;
  compiled = undefined;
}

/** Credentials inside URLs and URL-shaped connection strings. */
export function redactUrlCredentials(text: string): string {
  if (!text.includes("://") || !text.includes("@")) return text;
  return text
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"`]*):([^\s@/'"`]+)@/gi,
      (_match, scheme: string, user: string) => `${scheme}${user}:${URL_CREDENTIAL_MASK}@`,
    )
    .replace(
      // Token-only userinfo, e.g. https://<token>@git.example.com/repo.git
      /\b((?:https?|git|ssh):\/\/)([A-Za-z0-9_-]{16,})@/gi,
      (_match, scheme: string) => `${scheme}${URL_CREDENTIAL_MASK}@`,
    );
}

/** Known secret values in free text. */
export function maskSecretValues(text: string): string {
  if (!text) return text;
  const matcher = compile();
  if (!matcher) return text;
  return text.replace(matcher.re, (value) => `[secret:${matcher.names.get(value) ?? "value"}]`);
}

export function maskSecretsInText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return maskSecretValues(redactUrlCredentials(text));
}

/** Deep variant for JSON values such as a run's result_json. */
export function maskSecretsInValue<T>(value: T): T {
  if (typeof value === "string") return maskSecretsInText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => maskSecretsInValue(entry)) as T;
  if (typeof value !== "object" || value === null) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = maskSecretsInValue(entry);
  }
  return out as T;
}
