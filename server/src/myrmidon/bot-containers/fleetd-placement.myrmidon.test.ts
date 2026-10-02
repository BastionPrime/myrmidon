import { describe, expect, it } from "vitest";

import {
  effectiveBotSettings,
  fleetGatewayApiBaseUrl,
  type InstanceBotSettings,
} from "./fleetd-placement.js";
import type { FleetHostConfig } from "./fleetd-hosts.js";

// Everything here is placeholder data: fake names and example.com addresses.

const INSTANCE: InstanceBotSettings = {
  hindsightUrl: "http://hindsight.internal:8890",
  llmBaseUrl: "http://llm.internal:4000",
  volumeRoot: "/srv/myrmidon-bots",
  network: "myrmidon-bots",
  imageAllowlist: ["ghcr.io/example/bot@sha256:*"],
  boardHost: "paperclip-server-1",
};

const HOST: FleetHostConfig = {
  name: "vmexec",
  url: "http://fleetd.internal:9100",
  tokenSecret: "fleetd-vmexec-token",
};

describe("myrmidon(FLEETD-VMEXEC) placement — effective settings per host", () => {
  it("returns the instance-wide settings untouched for the default (local) host", () => {
    expect(effectiveBotSettings(INSTANCE, null)).toEqual(INSTANCE);
    expect(effectiveBotSettings(INSTANCE, undefined)).toEqual(INSTANCE);
  });

  it("keeps the instance-wide value for every field the entry does not carry", () => {
    expect(effectiveBotSettings(INSTANCE, HOST)).toEqual(INSTANCE);
  });

  it("applies exactly the fields the entry overrides", () => {
    const host: FleetHostConfig = {
      ...HOST,
      hindsightUrl: "http://hindsight.internal:8890",
      llmBaseUrl: "http://llm.internal:4000",
      volumeRoot: "/srv/bots",
      network: "bots-net",
      imageAllowlist: ["ghcr.io/example/other@sha256:*"],
      boardExtraHost: "board.internal",
    };
    expect(effectiveBotSettings(INSTANCE, host)).toEqual({
      hindsightUrl: "http://hindsight.internal:8890",
      llmBaseUrl: "http://llm.internal:4000",
      volumeRoot: "/srv/bots",
      network: "bots-net",
      imageAllowlist: ["ghcr.io/example/other@sha256:*"],
      boardHost: "board.internal",
    });
  });

  it("an empty override list is not the same as an omitted one for the image allowlist", () => {
    // An entry that explicitly carries an empty list means "nothing may run there";
    // it must not fall back to the instance-wide allowlist.
    const host: FleetHostConfig = { ...HOST, imageAllowlist: [] };
    expect(effectiveBotSettings(INSTANCE, host).imageAllowlist).toEqual([]);
  });
});

describe("myrmidon(FLEETD-VMEXEC) placement — the card's gateway base URL", () => {
  it("builds http://<host>:<port> from the fleetd entry's host and the reported port", () => {
    expect(fleetGatewayApiBaseUrl("http://fleetd.internal:9100", 18642)).toBe("http://fleetd.internal:18642");
  });

  it("keeps a hostname as-is and drops the fleetd port from the host part", () => {
    expect(fleetGatewayApiBaseUrl("http://fleetd.example.com:9100", 18643)).toBe("http://fleetd.example.com:18643");
  });

  it("refuses a missing port instead of guessing one", () => {
    expect(() => fleetGatewayApiBaseUrl("http://fleetd.internal:9100", undefined)).toThrow(/did not report a gateway port/);
  });

  it("refuses an out-of-range or non-integer port", () => {
    for (const bad of [0, -1, 70000, 1.5, Number.NaN]) {
      expect(() => fleetGatewayApiBaseUrl("http://fleetd.internal:9100", bad)).toThrow(/invalid gateway port|did not report/);
    }
  });

  it("refuses a non-http fleetd url", () => {
    expect(() => fleetGatewayApiBaseUrl("https://fleetd.internal:9100", 18642)).toThrow(/must be http/);
  });
});