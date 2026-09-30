// myrmidon(EGRESS-B): pure helpers for the "Egress" surfaces.
//
// The server decides; this file only turns what a person types into the same
// shape the server stores, and names why a project cannot be switched to
// blocking yet. Keeping the rules here means the form says "not a destination"
// before a save round-trip, and the test for it needs no browser.

export type EgressProjectMode = "log" | "block";

/** Host names and IPv4 literals only — the same rule as the server and the
 *  proxy: the list is matched by name, and no client in the fleet understands a
 *  pattern. */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

export interface ParsedAllowlist {
  /** What the server should store, deduplicated in the order typed. */
  entries: string[];
  /** What cannot be a destination, one message per line. */
  problems: string[];
}

/** Reads one line the way the server's `parseEgressDestination` would: the
 *  scheme of a URL is dropped, `host` alone means every port on it. */
function parseLine(raw: string): string | null {
  let text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text);
  let schemePort: number | null = null;
  if (scheme) {
    schemePort = DEFAULT_PORTS[scheme[1]] ?? null;
    text = text.slice(scheme[0].length);
    if (/[/?#]/.test(text)) return null;
  }
  if (text.includes("/") || text.includes("?") || text.includes("#") || /\s/.test(text)) return null;
  const [host, port, ...rest] = text.split(":");
  if (rest.length > 0 || !host || !HOST_PATTERN.test(host)) return null;
  if (port === undefined || port === "" || port === "*") {
    return schemePort === null ? host : `${host}:${schemePort}`;
  }
  if (!/^\d+$/.test(port)) return null;
  const value = Number(port);
  if (value < 1 || value > 65535) return null;
  return `${host}:${value}`;
}

/** Reads the textarea: one destination per line (a comma also separates, so a
 *  pasted list works). Lines that cannot be destinations are reported, not
 *  silently dropped — a typo must not look like an empty list. */
export function parseAllowlistText(text: string): ParsedAllowlist {
  const entries: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]+/)) {
    if (part.trim().length === 0) continue;
    const parsed = parseLine(part);
    if (parsed === null) problems.push(`${part.trim()} is not a destination (use host or host:port).`);
    else if (!seen.has(parsed)) {
      seen.add(parsed);
      entries.push(parsed);
    }
  }
  return { entries, problems };
}

export function formatAllowlistText(entries: string[]): string {
  return entries.join("\n");
}

/** Why the project may not be switched to blocking, or null when it may.
 *  The same condition the server enforces, so the toggle can be disabled with
 *  the reason in front of the person instead of a refused save. */
export function blockGateReason(input: { verified: boolean; entries: string[] }): string | null {
  if (!input.verified) return "Tick “Verified against the observation journal” first: blocking before that can break the project's work.";
  if (input.entries.length === 0) return "Add at least one allowed destination: an empty list would refuse everything.";
  return null;
}

export function describeMode(mode: EgressProjectMode): string {
  return mode === "block" ? "Blocking" : "Journal only";
}

/** What the section should say about the stored state: a row can be `block`
 *  while the proxy still records it (the list stopped being verified). */
export function describeEffective(mode: EgressProjectMode, effectiveMode: EgressProjectMode): string {
  if (mode === "block" && effectiveMode === "log") {
    return "Blocking is saved but not in force: the list is not marked verified, so the proxy still only records.";
  }
  return mode === "block"
    ? "The proxy refuses destinations that are on neither list and records every refusal."
    : "The proxy records everything this project reaches and refuses nothing.";
}

/** One line for the refusal feed. */
export function describeRefusal(refusal: { destination?: unknown; port?: unknown; bot?: unknown; result?: unknown }): string {
  const host = typeof refusal.destination === "string" ? refusal.destination : "?";
  const port = typeof refusal.port === "number" ? `:${refusal.port}` : "";
  const bot = typeof refusal.bot === "string" && refusal.bot ? refusal.bot : "unknown bot";
  return `${bot} → ${host}${port}`;
}