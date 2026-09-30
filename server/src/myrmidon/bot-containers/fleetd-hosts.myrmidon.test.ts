import { describe, expect, it } from "vitest";

import { FLEET_HOSTS_ENV, cardFleetHost, parseFleetHosts } from "./fleetd-hosts.js";

// Everything here is placeholder data: fake names and example.com addresses.

const ENTRY = (over: Record<string, unknown> = {}): string =>
  JSON.stringify([{ name: "host-a", url: "http://fleetd.example.com:9100", tokenSecret: "secret-a", ...over }]);

describe("myrmidon(FLEETD-VMEXEC) fleet hosts — parsing", () => {
  it("an unset or empty setting yields no hosts", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(parseFleetHosts(raw).size).toBe(0);
    }
  });

  it("parses name/url/tokenSecret, trims and strips trailing slashes", () => {
    const hosts = parseFleetHosts(
      JSON.stringify([{ name: " host-a ", url: "http://fleetd.example.com:9100/", tokenSecret: " secret-a " }]),
    );
    expect(hosts.get("host-a")).toEqual({
      name: "host-a",
      url: "http://fleetd.example.com:9100",
      tokenSecret: "secret-a",
    });
  });

  it("rejects non-JSON, non-array, non-object entries", () => {
    expect(() => parseFleetHosts("not json")).toThrow(/not valid JSON/);
    expect(() => parseFleetHosts('{"name":"host-a"}')).toThrow(/must be a JSON array/);
    expect(() => parseFleetHosts('["host-a"]')).toThrow(/every entry must be an object/);
  });

  it("rejects unknown keys — the entry shape stays closed", () => {
    expect(() => parseFleetHosts(ENTRY({ token: "value" }))).toThrow(/unknown key "token"/);
    expect(() => parseFleetHosts(ENTRY({ volumeRoot: "/data" }))).toThrow(/unknown key "volumeRoot"/);
  });

  it("rejects a bad name, a non-http url, an empty token name, duplicates", () => {
    expect(() => parseFleetHosts(ENTRY({ name: "Host A" }))).toThrow(/host name must match/);
    expect(() => parseFleetHosts(ENTRY({ url: "https://fleetd.example.com" }))).toThrow(/must be http:\/\//);
    expect(() => parseFleetHosts(ENTRY({ tokenSecret: "" }))).toThrow(/missing tokenSecret/);
    // ENTRY() already wraps its object in an array, so a "list of two" needs the bare objects:
    const one = { name: "host-a", url: "http://fleetd.example.com:9100", tokenSecret: "secret-a" };
    expect(() => parseFleetHosts(JSON.stringify([one, { ...one }]))).toThrow(/duplicate host name/);
  });

  it("names the setting in every error", () => {
    try {
      parseFleetHosts("not json");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain(FLEET_HOSTS_ENV);
    }
  });
});

describe("myrmidon(FLEETD-VMEXEC) fleet hosts — the card's host", () => {
  it("a card without container.host is the default (local) host", () => {
    expect(cardFleetHost({})).toBeNull();
    expect(cardFleetHost({ container: { enabled: true, image: "example.com/bot@sha256:aa", memoryMb: 1024, cpus: 1, pidsLimit: 256 } })).toBeNull();
    expect(cardFleetHost({ container: { host: null } })).toBeNull();
  });

  it("a card naming a host returns the trimmed name", () => {
    expect(cardFleetHost({ container: { host: " vmexec " } })).toBe("vmexec");
  });

  it("a malformed host name is an error, not a silent fallback", () => {
    expect(() => cardFleetHost({ container: { host: "Host A" } })).toThrow(/container\.host must be a host name/);
    expect(() => cardFleetHost({ container: { host: 42 } })).toThrow(/container\.host must be a host name/);
    expect(() => cardFleetHost({ container: { host: "local" } })).toThrow(/not a host: omit container\.host/);
  });
});
