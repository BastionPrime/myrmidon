// myrmidon(BROWSER-CONSOLE): shared validators + fleet parsing tests.

import { describe, expect, it } from "vitest";
import {
  browserSiteDataDeleteSchema,
  parseBrowserFleet,
} from "./myrmidon-browser-console.js";

describe("browser site data domain validation", () => {
  const check = (domain: string) => browserSiteDataDeleteSchema.safeParse({ domain });

  it("accepts bare domains and subdomains", () => {
    expect(check("example.com").success).toBe(true);
    expect(check("a.example.com").success).toBe(true);
    expect(check("sub-domain.example.co").success).toBe(true);
  });

  it("rejects URLs, paths, schemes and junk", () => {
    expect(check("https://example.com").success).toBe(false);
    expect(check("example.com/path").success).toBe(false);
    expect(check("example.com:8080").success).toBe(false);
    expect(check("").success).toBe(false);
    expect(check("localhost").success).toBe(false);
    expect(check("exa mple.com").success).toBe(false);
    expect(check(".example.com").success).toBe(false);
  });
});

describe("browser fleet env parsing", () => {
  it("absent or empty reads as an empty fleet", () => {
    expect(parseBrowserFleet(undefined)).toEqual({ ok: true, browsers: [] });
    expect(parseBrowserFleet("  ")).toEqual({ ok: true, browsers: [] });
  });

  it("parses the documented shape", () => {
    const parsed = parseBrowserFleet(
      JSON.stringify([{ id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1", ig: "socks nd1" } }]),
    );
    expect(parsed).toEqual({
      ok: true,
      browsers: [{ id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1", ig: "socks nd1" } }],
    });
  });

  it("refuses broken JSON, non-arrays, bad ids and duplicates", () => {
    expect(parseBrowserFleet("{not json").ok).toBe(false);
    expect(parseBrowserFleet('{"id":"x"}').ok).toBe(false);
    expect(parseBrowserFleet('[{"id":"Bad_Id","displayName":"x","egress":{}}]').ok).toBe(false);
    expect(parseBrowserFleet('[{"id":"","displayName":"x","egress":{}}]').ok).toBe(false);
    expect(
      parseBrowserFleet('[{"id":"browser-a","displayName":"a","egress":{}},{"id":"browser-a","displayName":"b","egress":{}}]').ok,
    ).toBe(false);
    expect(parseBrowserFleet('[{"id":"browser-a","displayName":"x"}]').ok).toBe(true);
  });
});
