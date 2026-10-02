// myrmidon(EGRESS-B): the rules a person's typing meets before a save.
// Pure helpers — no DOM, no server.

import { describe, expect, it } from "vitest";
import {
  blockGateReason,
  describeEffective,
  describeRefusal,
  formatAllowlistText,
  parseAllowlistText,
} from "./botEgressConfig";

describe("myrmidon(EGRESS-B) parseAllowlistText", () => {
  it("reads one destination per line, and a pasted comma-separated list", () => {
    expect(parseAllowlistText("api.example.com\nmedia.example.com:8443")).toEqual({
      entries: ["api.example.com", "media.example.com:8443"],
      problems: [],
    });
    expect(parseAllowlistText("api.example.com, media.example.com:8443").entries).toEqual([
      "api.example.com",
      "media.example.com:8443",
    ]);
  });

  it("drops the scheme of a URL and keeps its port", () => {
    expect(parseAllowlistText("https://api.example.com").entries).toEqual(["api.example.com:443"]);
    expect(parseAllowlistText("http://api.example.com").entries).toEqual(["api.example.com:80"]);
  });

  it("lowercases, deduplicates and ignores blank lines", () => {
    expect(parseAllowlistText("\nAPI.Example.COM\n\napi.example.com\n").entries).toEqual(["api.example.com"]);
  });

  it("reports a line that cannot be a destination, rather than dropping it", () => {
    const parsed = parseAllowlistText("*.example.com\napi.example.com/path\nok.example.com");
    expect(parsed.entries).toEqual(["ok.example.com"]);
    expect(parsed.problems).toHaveLength(2);
  });

  it("round-trips through the text form", () => {
    expect(formatAllowlistText(["a.example.com", "b.example.com:1"])).toBe("a.example.com\nb.example.com:1");
  });
});

describe("myrmidon(EGRESS-B) the blocking gate", () => {
  it("refuses blocking without a verified list or with an empty one", () => {
    expect(blockGateReason({ verified: false, entries: ["api.example.com"] })).toMatch(/Verified/);
    expect(blockGateReason({ verified: true, entries: [] })).toMatch(/at least one allowed destination/);
    expect(blockGateReason({ verified: true, entries: ["api.example.com"] })).toBeNull();
  });

  it("says when a saved blocking mode is not in force", () => {
    expect(describeEffective("block", "log")).toMatch(/not in force/);
    expect(describeEffective("block", "block")).toMatch(/refuses destinations/);
    expect(describeEffective("log", "log")).toMatch(/refuses nothing/);
  });

  it("names a refusal", () => {
    expect(describeRefusal({ bot: "agent-a", destination: "unknown.example.com", port: 443 })).toBe(
      "agent-a → unknown.example.com:443",
    );
    expect(describeRefusal({})).toBe("unknown bot → ?");
  });
});