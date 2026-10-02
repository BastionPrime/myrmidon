import { describe, expect, it } from "vitest";
import {
  hostMatchesAllowlistDomain,
  isUrlAllowedByAllowlist,
  normalizeAllowlistDomain,
  normalizeAllowlistDomains,
} from "../src/allowlist";

const TENDER = ["tender.example"];

describe("normalizeAllowlistDomain", () => {
  it("accepts a bare lowercase hostname", () => {
    expect(normalizeAllowlistDomain("tender.example")).toBe("tender.example");
  });

  it("trims, lowercases and drops a trailing dot", () => {
    expect(normalizeAllowlistDomain("  TENDER.Example. ")).toBe("tender.example");
  });

  it("rejects entries with scheme, path, port, userinfo or wildcard", () => {
    expect(normalizeAllowlistDomain("https://tender.example")).toBeNull();
    expect(normalizeAllowlistDomain("tender.example/tenders")).toBeNull();
    expect(normalizeAllowlistDomain("tender.example:8443")).toBeNull();
    expect(normalizeAllowlistDomain("user@tender.example")).toBeNull();
    expect(normalizeAllowlistDomain("*.tender.example")).toBeNull();
  });

  it("rejects non-strings, empties and too-long values", () => {
    expect(normalizeAllowlistDomain(null)).toBeNull();
    expect(normalizeAllowlistDomain(17)).toBeNull();
    expect(normalizeAllowlistDomain("")).toBeNull();
    expect(normalizeAllowlistDomain("a".repeat(254))).toBeNull();
  });
});

describe("normalizeAllowlistDomains", () => {
  it("deduplicates and sorts", () => {
    expect(normalizeAllowlistDomains(["b.example", "a.example", "a.example"])).toEqual(["a.example", "b.example"]);
  });

  it("drops unreadable entries and tolerates non-arrays", () => {
    expect(normalizeAllowlistDomains(["tender.example", "not a domain"])).toEqual(["tender.example"]);
    expect(normalizeAllowlistDomains(undefined)).toEqual([]);
    expect(normalizeAllowlistDomains("tender.example")).toEqual([]);
  });
});

describe("hostMatchesAllowlistDomain", () => {
  it("matches the domain itself and its subdomains", () => {
    expect(hostMatchesAllowlistDomain("tender.example", "tender.example")).toBe(true);
    expect(hostMatchesAllowlistDomain("www.tender.example", "tender.example")).toBe(true);
  });

  it("never matches a sibling or a lookalike across the dot boundary", () => {
    expect(hostMatchesAllowlistDomain("eviltender.example", "tender.example")).toBe(false);
    expect(hostMatchesAllowlistDomain("tender.example.evil.test", "tender.example")).toBe(false);
    expect(hostMatchesAllowlistDomain("tender.example", "notender.example")).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(hostMatchesAllowlistDomain("WWW.Tender.Example", "tender.example")).toBe(true);
  });
});

describe("isUrlAllowedByAllowlist", () => {
  it("allows http(s) urls on allowlisted hosts", () => {
    expect(isUrlAllowedByAllowlist("https://tender.example/tenders", TENDER)).toBe(true);
    expect(isUrlAllowedByAllowlist("http://www.tender.example", TENDER)).toBe(true);
  });

  it("refuses non-http(s) schemes", () => {
    expect(isUrlAllowedByAllowlist("file:///etc/passwd", TENDER)).toBe(false);
    expect(isUrlAllowedByAllowlist("javascript:alert(1)", TENDER)).toBe(false);
    expect(isUrlAllowedByAllowlist("wss://tender.example", TENDER)).toBe(false);
  });

  it("refuses urls outside the allowlist and unparseable urls", () => {
    expect(isUrlAllowedByAllowlist("https://other.example", TENDER)).toBe(false);
    expect(isUrlAllowedByAllowlist("not a url", TENDER)).toBe(false);
  });

  it("fails closed on an empty or missing allowlist", () => {
    expect(isUrlAllowedByAllowlist("https://tender.example", [])).toBe(false);
    expect(isUrlAllowedByAllowlist("https://tender.example", ["unparseable!!"])).toBe(false);
  });
});
