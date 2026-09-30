// server/src/myrmidon/bot-containers/egress-policy.ts
//
// myrmidon(EGRESS-B): the decision half of the bots' outward traffic. EGRESS-A
// (egress.ts, tools/egress-proxy) put every bot behind a fleet proxy that
// records destinations and refuses none. This module holds the lists and the
// per-project mode the proxy then enforces:
//
//   - a *project* policy — the destinations every bot of that project may
//     reach, and whether the project still records (`log`) or already refuses
//     (`block`);
//   - a *bot* policy — the project the journal should name for that bot, and
//     the extra destinations only that one bot may reach.
//
// The one rule the whole item turns on: nothing may be switched to `block`
// before its list was compared with the observation period's journal. The plan
// records that risk in as many words ("without an inventory of the real
// destinations, blocking breaks the fleet's work"), so `block` without a
// verified, non-empty list is refused here — and, belt and braces, downgraded
// to `log` again when the document for the proxy is built, so a row that became
// inconsistent (someone turned `verified` back off by hand) cannot take a
// project's egress down.
//
// The module is pure: rows in, decisions out. The routes read the table, the
// proxy reads the document this module builds, and both are testable without a
// database (egress-policy.myrmidon.test.ts).

import type { BotProfileInputError } from "./profile-input.js";

/** `log` records a destination, `block` refuses what is not on the lists. */
export type EgressProjectMode = "log" | "block";

export const EGRESS_PROJECT_MODES: readonly EgressProjectMode[] = ["log", "block"];

/** The instance setting naming the shared token the proxy presents. */
export const BOT_EGRESS_TOKEN_ENV = "MYRMIDON_BOT_EGRESS_TOKEN";
/** The instance setting naming the proxy's refusal feed (board reads it for the UI). */
export const BOT_EGRESS_REFUSALS_URL_ENV = "MYRMIDON_BOT_EGRESS_REFUSALS_URL";

/** Version of the document the proxy fetches. The proxy refuses a document it
 *  does not know, rather than guessing at a shape that changed under it. */
export const EGRESS_POLICY_DOCUMENT_VERSION = 1;

/** A destination as stored: lowercase host and an optional port. `port: null`
 *  means "any port on that host", which is what a bare host means. */
export interface EgressDestination {
  host: string;
  port: number | null;
}

export interface ProjectEgressPolicy {
  mode: EgressProjectMode;
  verified: boolean;
  allow: EgressDestination[];
}

export interface BotEgressPolicy {
  project: string;
  allow: EgressDestination[];
}

/** One row of `myrmidon_egress_policies`, as read from the database. */
export interface EgressPolicyRow {
  scope: string;
  targetId: string;
  mode: string | null;
  verified: boolean | null;
  allow: unknown;
  project: string | null;
}

/** The document the proxy fetches (`GET /api/myrmidon/bot-egress/policy`). */
export interface EgressPolicyDocument {
  version: number;
  bots: Record<string, { project: string; allow: string[] }>;
  projects: Record<string, { mode: EgressProjectMode; allow: string[] }>;
}

/** Thrown by the readers/assertions; the route layer turns it into a 422. */
export class EgressPolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressPolicyInputError";
  }
}

/** Host names and IPv4 literals only. The list is matched by name, never by
 *  pattern (no client in the fleet understands NO_PROXY globs), so an entry
 *  with a `*`, a path or a scheme is a mistake worth naming. */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/**
 * Parses one destination as a person would type it: `host`, `host:port`, or a
 * URL (`https://host`, `http://host:8080`) whose scheme is dropped. What is
 * stored is only the host and the port — the proxy never sees a path or a
 * query, and neither should the list.
 */
export function parseEgressDestination(raw: string): EgressDestination | null {
  let text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//.exec(text);
  let schemePort: number | null = null;
  if (schemeMatch) {
    schemePort = DEFAULT_PORTS[schemeMatch[1]] ?? null;
    text = text.slice(schemeMatch[0].length);
    // A URL with anything after the authority (a path, a query) is not a
    // destination: the list is host[:port], nothing else.
    if (/[/?#]/.test(text)) return null;
  }
  if (text.includes("/") || text.includes("?") || text.includes("#") || /\s/.test(text)) return null;
  const [hostPart, portPart, ...rest] = text.split(":");
  if (rest.length > 0) return null;
  if (!hostPart || !HOST_PATTERN.test(hostPart)) return null;
  if (portPart === undefined || portPart === "" || portPart === "*") {
    return { host: hostPart, port: schemePort };
  }
  if (!/^\d+$/.test(portPart)) return null;
  const port = Number(portPart);
  if (port < 1 || port > 65535) return null;
  return { host: hostPart, port };
}

/** The stored form of a destination: exactly what the proxy compares. */
export function formatEgressDestination(destination: EgressDestination): string {
  return destination.port === null ? destination.host : `${destination.host}:${destination.port}`;
}

/** Same destination, ignoring order and duplicates. */
export function sameDestination(left: EgressDestination, right: EgressDestination): boolean {
  return left.host === right.host && left.port === right.port;
}

/**
 * Reads a stored allowlist. Anything unreadable (a hand-edited row, an old
 * value, the wrong type) throws instead of reading as "nothing is allowed":
 * an empty list means "this list was never filled in", and the two must not
 * look the same to the caller that decides about blocking.
 */
export function parseEgressAllowlist(raw: unknown): EgressDestination[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new EgressPolicyInputError("allow must be an array of destinations");
  }
  const seen = new Set<string>();
  const allow: EgressDestination[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new EgressPolicyInputError("allow entries must be strings");
    }
    const parsed = parseEgressDestination(entry);
    if (parsed === null) {
      throw new EgressPolicyInputError(`allow entry is not a destination: "${entry}"`);
    }
    const key = formatEgressDestination(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    allow.push(parsed);
  }
  return allow;
}

/** Validates what a form sent, before it is stored. */
export function parseEgressAllowlistInput(raw: unknown): EgressDestination[] {
  return parseEgressAllowlist(raw);
}

export function readProjectEgressPolicy(row: EgressPolicyRow | null | undefined): ProjectEgressPolicy {
  if (!row) return { mode: "log", verified: false, allow: [] };
  const rawMode = (row.mode ?? "log").trim().toLowerCase();
  const mode: EgressProjectMode = rawMode === "block" ? "block" : "log";
  return { mode, verified: row.verified === true, allow: parseEgressAllowlist(row.allow) };
}

export function readBotEgressPolicy(row: EgressPolicyRow | null | undefined): BotEgressPolicy {
  if (!row) return { project: "", allow: [] };
  return { project: (row.project ?? "").trim(), allow: parseEgressAllowlist(row.allow) };
}

/**
 * The mode the proxy is actually told to use. `block` survives only with a
 * verified, non-empty list; everything else is `log`. This is the same
 * condition the save route enforces, applied again to the stored row: a row
 * that was made inconsistent afterwards must fall back to recording, not
 * start refusing a project's traffic.
 */
export function effectiveProjectEgressMode(policy: ProjectEgressPolicy): EgressProjectMode {
  if (policy.mode !== "block") return "log";
  if (!policy.verified) return "log";
  if (policy.allow.length === 0) return "log";
  return "block";
}

/**
 * The rule a save must satisfy, as a message or null. The plan's risk note is
 * the reason: a project may only stop recording once its list was compared
 * with the journal of the observation period.
 */
export function projectPolicySaveRefusal(policy: ProjectEgressPolicy): string | null {
  if (policy.mode !== "block") return null;
  if (!policy.verified) {
    return "blocking needs the list to be verified against the observation journal: tick \"Verified\" first, or keep the project in journal mode";
  }
  if (policy.allow.length === 0) {
    return "blocking needs at least one allowed destination: an empty list would refuse every destination";
  }
  return null;
}

/**
 * The document the proxy fetches. Projects are keyed by the name the journal
 * shows (the proxy has no database and must not learn one); bots are keyed by
 * their bot key. An unverified or empty project list is published as `log`, so
 * the document never carries a decision the table would refuse on save.
 */
export function buildEgressPolicyDocument(rows: readonly EgressPolicyRow[]): EgressPolicyDocument {
  const document: EgressPolicyDocument = {
    version: EGRESS_POLICY_DOCUMENT_VERSION,
    bots: {},
    projects: {},
  };
  // Bots first: a bot names its project, and the project row is keyed by that name.
  const projectNames = new Set<string>();
  for (const row of rows) {
    if (row.scope !== "bot") continue;
    const policy = readBotEgressPolicy(row);
    document.bots[row.targetId] = {
      project: policy.project,
      allow: policy.allow.map(formatEgressDestination),
    };
    if (policy.project) projectNames.add(policy.project);
  }
  // Project rows are keyed by the project's name in the board, which the row
  // itself does not carry: the caller passes it in `project` for scope=project
  // too (the routes resolve id -> name). A project row without a name cannot be
  // published — the proxy would never match it.
  for (const row of rows) {
    if (row.scope !== "project") continue;
    const name = (row.project ?? "").trim();
    if (!name) continue;
    const policy = readProjectEgressPolicy(row);
    document.projects[name] = {
      mode: effectiveProjectEgressMode(policy),
      allow: policy.allow.map(formatEgressDestination),
    };
  }
  return document;
}

/** For the routes' error mapping: both input failures read the same to a caller. */
export function isEgressPolicyInputError(error: unknown): error is BotProfileInputError | EgressPolicyInputError {
  return error instanceof EgressPolicyInputError || (error instanceof Error && error.name === "BotProfileInputError");
}