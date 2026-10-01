import { describe, expect, it } from "vitest";

import { FLEET_HOSTS_ENV, cardFleetHost, parseFleetHosts } from "./fleetd-hosts.js";
import { readFleetdDriverConfig } from "./fleetd-driver.js";

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
    expect(() => parseFleetHosts(ENTRY({ hindsightURL: "http://x" }))).toThrow(/unknown key "hindsightURL"/);
  });

  it("rejects a bad name, a non-http url, an empty token name, duplicates", () => {
    expect(() => parseFleetHosts(ENTRY({ name: "Host A" }))).toThrow(/host name must match/);
    expect(() => parseFleetHosts(ENTRY({ url: "https://fleetd.example.com" }))).toThrow(/url must be http/);
    expect(() => parseFleetHosts(ENTRY({ tokenSecret: "  " }))).toThrow(/missing tokenSecret/);
    expect(() =>
      parseFleetHosts(
        JSON.stringify([
          { name: "host-a", url: "http://a:1", tokenSecret: "s" },
          { name: "host-a", url: "http://b:2", tokenSecret: "s" },
        ]),
      ),
    ).toThrow(/duplicate host name/);
    expect(FLEET_HOSTS_ENV).toBe("MYRMIDON_FLEET_HOSTS");
  });
});

describe("myrmidon(FLEETD-VMEXEC) fleet hosts — per-host overrides", () => {
  it("carries no override fields when the entry states none", () => {
    const host = parseFleetHosts(ENTRY()).get("host-a");
    expect(host).toEqual({ name: "host-a", url: "http://fleetd.example.com:9100", tokenSecret: "secret-a" });
  });

  it("parses every override field, trimmed, with trailing slashes stripped from urls", () => {
    const host = parseFleetHosts(
      ENTRY({
        hindsightUrl: "http://hindsight.internal:8890/",
        llmBaseUrl: " http://llm.internal:4000 ",
        boardExtraHost: "board.internal",
        volumeRoot: "/srv/bots",
        network: "bots-net",
        imageAllowlist: [" ghcr.io/example/bot@sha256:* ", ""],
      }),
    ).get("host-a");
    expect(host).toEqual({
      name: "host-a",
      url: "http://fleetd.example.com:9100",
      tokenSecret: "secret-a",
      hindsightUrl: "http://hindsight.internal:8890",
      llmBaseUrl: "http://llm.internal:4000",
      boardExtraHost: "board.internal",
      volumeRoot: "/srv/bots",
      network: "bots-net",
      imageAllowlist: ["ghcr.io/example/bot@sha256:*"],
    });
  });

  it("rejects a non-http override url and an empty required string", () => {
    expect(() => parseFleetHosts(ENTRY({ hindsightUrl: "https://hindsight.internal:8890" }))).toThrow(/hindsightUrl" must be http/);
    expect(() => parseFleetHosts(ENTRY({ llmBaseUrl: "llm.internal:4000" }))).toThrow(/llmBaseUrl" must be http/);
    expect(() => parseFleetHosts(ENTRY({ network: "   " }))).toThrow(/network" is empty/);
  });

  it("rejects a malformed boardExtraHost and a relative volumeRoot", () => {
    expect(() => parseFleetHosts(ENTRY({ boardExtraHost: "not a host" }))).toThrow(/must be a hostname/);
    expect(() => parseFleetHosts(ENTRY({ volumeRoot: "srv/bots" }))).toThrow(/must be an absolute path/);
  });

  it("rejects a non-array or non-string imageAllowlist", () => {
    expect(() => parseFleetHosts(ENTRY({ imageAllowlist: "ghcr.io/example/bot" }))).toThrow(/must be an array of strings/);
    expect(() => parseFleetHosts(ENTRY({ imageAllowlist: [1, 2] }))).toThrow(/must be an array of strings/);
  });
});

describe("myrmidon(FLEETD-VMEXEC) fleet hosts — the card's host", () => {
  it("no container block, no host field and null all mean the default (local) host", () => {
    expect(cardFleetHost({})).toBeNull();
    expect(cardFleetHost({ container: {} })).toBeNull();
    expect(cardFleetHost({ container: { host: null } })).toBeNull();
    expect(cardFleetHost({ container: undefined })).toBeNull();
  });

  it("returns a valid host name, trimmed", () => {
    expect(cardFleetHost({ container: { host: " vmexec " } })).toBe("vmexec");
  });

  it("throws on a malformed host or the reserved name \"local\"", () => {
    expect(() => cardFleetHost({ container: { host: "Host A" } })).toThrow(/must be a host name/);
    expect(() => cardFleetHost({ container: { host: "local" } })).toThrow(/is not a host/);
  });
});

describe("myrmidon(FLEETD-VMEXEC) fleet hosts — driver config binding", () => {
  it("reads the token from the environment when no explicit values are given", () => {
    const cfg = readFleetdDriverConfig({ MYRMIDON_FLEET_HOST_URL: "http://f:9100", MYRMIDON_FLEET_HOST_TOKEN: "t" });
    expect(cfg).toEqual({ baseUrl: "http://f:9100", token: "t" });
  });

  it("throws when the url or the token is missing", () => {
    expect(() => readFleetdDriverConfig({ MYRMIDON_FLEET_HOST_TOKEN: "t" })).toThrow(/MYRMIDON_FLEET_HOST_URL/);
    expect(() => readFleetdDriverConfig({ MYRMIDON_FLEET_HOST_URL: "http://f:9100" })).toThrow(/MYRMIDON_FLEET_HOST_TOKEN/);
  });
});