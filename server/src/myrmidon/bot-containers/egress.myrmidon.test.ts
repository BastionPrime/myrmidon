import { describe, expect, it } from "vitest";

import {
  assertBotEgressSettings,
  BOT_EGRESS_MODE_ENV,
  BOT_EGRESS_NO_PROXY_ENV,
  BOT_EGRESS_PROXY_ENV,
  botEgressNoProxy,
  botEgressProxyUrl,
  buildBotEgressEnvEntries,
  readBotEgressSettings,
} from "./egress.js";
import { BotProfileInputError } from "./profile-input.js";

// Placeholder data only: example.com URLs and fake bot keys.

const PROXY = "http://egress.example.com:3128";
const BOARD = "http://board.example.com:3100";

function logModeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [BOT_EGRESS_MODE_ENV]: "log",
    [BOT_EGRESS_PROXY_ENV]: PROXY,
    ...extra,
  };
}

describe("myrmidon(EGRESS-A) readBotEgressSettings", () => {
  it("is off when nothing is set: the fleet keeps the behaviour it has today", () => {
    const settings = readBotEgressSettings({});
    expect(settings.mode).toBe("off");
    expect(settings.proxyUrl).toBeNull();
    expect(settings.extraNoProxy).toEqual([]);
    expect(buildBotEgressEnvEntries({ settings, botKey: "agent-a", boardUrl: BOARD })).toEqual({});
  });

  it("reads log mode, the proxy and the extra NO_PROXY hosts", () => {
    const settings = readBotEgressSettings(
      logModeEnv({ [BOT_EGRESS_MODE_ENV]: " LOG ", [BOT_EGRESS_NO_PROXY_ENV]: "media.example.com, ,other.example.com" }),
    );
    expect(settings.mode).toBe("log");
    expect(settings.proxyUrl).toBe(PROXY);
    expect(settings.extraNoProxy).toEqual(["media.example.com", "other.example.com"]);
  });

  it("refuses an unknown mode instead of reading it as off", () => {
    expect(() => readBotEgressSettings({ [BOT_EGRESS_MODE_ENV]: "block" })).toThrow(BotProfileInputError);
    expect(() => readBotEgressSettings({ [BOT_EGRESS_MODE_ENV]: "true" })).toThrow(/must be "off" or "log"/);
  });

  it("treats an empty string as unset, not as an unknown mode", () => {
    expect(readBotEgressSettings({ [BOT_EGRESS_MODE_ENV]: "  " }).mode).toBe("off");
  });
});

describe("myrmidon(EGRESS-A) assertBotEgressSettings", () => {
  it("accepts off with no proxy and log with an http proxy", () => {
    expect(() => assertBotEgressSettings(readBotEgressSettings({}))).not.toThrow();
    expect(() => assertBotEgressSettings(readBotEgressSettings(logModeEnv()))).not.toThrow();
  });

  it("fails log mode without a proxy: a profile that left the bot unproxied must not be built", () => {
    const settings = readBotEgressSettings({ [BOT_EGRESS_MODE_ENV]: "log" });
    expect(() => assertBotEgressSettings(settings)).toThrow(/MYRMIDON_BOT_EGRESS_PROXY must be set/);
  });

  it("fails a non-URL and a non-http proxy address", () => {
    expect(() => assertBotEgressSettings(readBotEgressSettings(logModeEnv({ [BOT_EGRESS_PROXY_ENV]: "not a url" })))).toThrow(
      /is not a URL/,
    );
    expect(() =>
      assertBotEgressSettings(readBotEgressSettings(logModeEnv({ [BOT_EGRESS_PROXY_ENV]: "socks5://egress.example.com:1080" }))),
    ).toThrow(/must be an http:\/\/ address/);
  });
});

describe("myrmidon(EGRESS-A) buildBotEgressEnvEntries", () => {
  it("names the bot in the proxy URL so the journal can attribute a destination", () => {
    const settings = readBotEgressSettings(logModeEnv());
    expect(botEgressProxyUrl(settings, "agent-a")).toBe("http://agent-a:egress@egress.example.com:3128/");
  });

  it("writes the proxy into every variable a client might read", () => {
    const entries = buildBotEgressEnvEntries({
      settings: readBotEgressSettings(logModeEnv()),
      botKey: "agent-a",
      boardUrl: BOARD,
    });
    const url = "http://agent-a:egress@egress.example.com:3128/";
    expect(entries.HTTP_PROXY.value).toBe(url);
    expect(entries.HTTPS_PROXY.value).toBe(url);
    expect(entries.ALL_PROXY.value).toBe(url);
    // Node's fetch ignores the proxy variables without this.
    expect(entries.NODE_USE_ENV_PROXY.value).toBe("1");
    expect(Object.values(entries).every((entry) => entry.secret === false)).toBe(true);
  });

  it("keeps the board and loopback out of the proxy, and keeps an unknown host in it", () => {
    const settings = readBotEgressSettings(logModeEnv({ [BOT_EGRESS_NO_PROXY_ENV]: "media.example.com" }));
    const noProxy = buildBotEgressEnvEntries({ settings, botKey: "agent-a", boardUrl: BOARD }).NO_PROXY.value.split(",");
    expect(noProxy).toContain("board.example.com");
    expect(noProxy).toContain("localhost");
    expect(noProxy).toContain("127.0.0.1");
    expect(noProxy).toContain("::1");
    expect(noProxy).toContain("media.example.com");
    // Peer bots and the sidecars of the bots' network stay in the journal.
    expect(noProxy).not.toContain("myrmidon-bot-agent-b");
  });

  it("drops the board host when there is none and never repeats a host", () => {
    const settings = readBotEgressSettings(logModeEnv({ [BOT_EGRESS_NO_PROXY_ENV]: "localhost, localhost" }));
    const noProxy = botEgressNoProxy(settings, null);
    expect(noProxy).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(botEgressNoProxy(settings, "not a url")).toEqual(["localhost", "127.0.0.1", "::1"]);
  });
});