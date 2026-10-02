// Allowlist enforcement inside the extension, before anything is sent.
//
// The gateway hands the company's allowlist of tender-platform domains over in
// `bridge.ready` and in the pairing response (design note §4.4). The gateway
// checks every action against the allowlist too — this is the second, local
// check ("defense in depth"): a compromised or buggy gateway cannot make the
// extension drive a page outside the allowlist, and a mistake on the wire is
// caught before the browser is touched.

/** An entry as the gateway sends it: a bare hostname, lowercase. */
export function normalizeAllowlistDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.length > 253) return null;
  if (value.includes("/") || value.includes(":") || value.includes("@") || value.includes("*")) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null;
  return value;
}

/** Deduplicated, sorted, canonical copy of an allowlist list. */
export function normalizeAllowlistDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const domain = normalizeAllowlistDomain(entry);
    if (domain) seen.add(domain);
  }
  return [...seen].sort();
}

/**
 * Hostname match: the host is the domain itself or a subdomain of it (the dot
 * is the boundary, so `tender.example.evil.test` never matches `tender.example`).
 */
export function hostMatchesAllowlistDomain(host: string, domain: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, "");
  const normalizedDomain = normalizeAllowlistDomain(domain);
  if (!normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

/** The local allowlist gate: may the extension act on this url at all? */
export function isUrlAllowedByAllowlist(url: string, domains: readonly string[]): boolean {
  const normalized = normalizeAllowlistDomains(domains);
  if (normalized.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return normalized.some((domain) => hostMatchesAllowlistDomain(parsed.hostname, domain));
}
