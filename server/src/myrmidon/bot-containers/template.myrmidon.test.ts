import { describe, expect, it } from "vitest";
import {
  BOT_LABEL_KEYS,
  BotContainerTemplateError,
  buildBinds,
  buildLabels,
  containerNameFor,
  isImageAllowed,
  mountRootSegment,
  parseImageAllowlist,
  resolveProfileFileTarget,
  validateBotKey,
} from "./template.js";
import type { CompiledProfileFile } from "./types.js";

describe("validateBotKey / containerNameFor", () => {
  it("accepts lowercase alphanumeric-with-hyphens keys, including uuids", () => {
    expect(() => validateBotKey("agent-a")).not.toThrow();
    expect(() => validateBotKey("3adb3ce4-40a4-4b1e-9c2a-000000000001")).not.toThrow();
    expect(containerNameFor("agent-a")).toBe("myrmidon-bot-agent-a");
  });

  it.each(["Agent-A", "agent_a", "agent.a", "-agent", "agent-", "agent/a", "", "agent a"])(
    "rejects %j",
    (botKey) => {
      expect(() => validateBotKey(botKey)).toThrow(BotContainerTemplateError);
    },
  );
});

describe("parseImageAllowlist / isImageAllowed", () => {
  it("parses a comma-separated list, trimming entries and dropping empties", () => {
    expect(parseImageAllowlist(" myrmidon-hermes:1.1.0 , myrmidon-hermes:* ,,")).toEqual([
      "myrmidon-hermes:1.1.0",
      "myrmidon-hermes:*",
    ]);
    expect(parseImageAllowlist(undefined)).toEqual([]);
  });

  it("allows only images that match one of the allowlist globs", () => {
    const allowlist = parseImageAllowlist("myrmidon-hermes:*,registry.example.com/myrmidon/*:1.1.*");
    expect(isImageAllowed("myrmidon-hermes:1.1.0", allowlist)).toBe(true);
    expect(isImageAllowed("myrmidon-hermes:1.2.0-rc1", allowlist)).toBe(true);
    expect(isImageAllowed("registry.example.com/myrmidon/hermes:1.1.5", allowlist)).toBe(true);
    expect(isImageAllowed("evil/other-image:latest", allowlist)).toBe(false);
    expect(isImageAllowed("myrmidon-hermes", allowlist)).toBe(false); // no tag: no glob matches
  });

  it("never lets '*' cross a '/' path segment", () => {
    const allowlist = parseImageAllowlist("myrmidon/*:1.1.0");
    // A caller cannot use the wildcard to smuggle in an extra registry/namespace segment.
    expect(isImageAllowed("myrmidon/evil/hermes:1.1.0", allowlist)).toBe(false);
    expect(isImageAllowed("myrmidon/hermes:1.1.0", allowlist)).toBe(true);
  });

  it("treats regex-special characters in a glob literally", () => {
    const allowlist = parseImageAllowlist("myrmidon-hermes:1.1.0");
    expect(isImageAllowed("myrmidon-hermes:1x1x0", allowlist)).toBe(false); // "." must not mean "any char"
  });
});

describe("buildBinds", () => {
  it("produces exactly the three fixed binds for a bot, and nothing else", () => {
    expect(buildBinds("/srv/myrmidon/bots", "agent-a")).toEqual([
      "/srv/myrmidon/bots/agent-a/hermes:/data/hermes",
      "/srv/myrmidon/bots/agent-a/workspace:/workspace",
      "/srv/myrmidon/bots/agent-a/scratch:/scratch",
    ]);
  });

  it("rejects a bot key that could escape the volume root", () => {
    expect(() => buildBinds("/srv/myrmidon/bots", "../../etc")).toThrow(BotContainerTemplateError);
  });
});

describe("mountRootSegment", () => {
  it("uses the container mount path, not the host bind suffix, for the hermes mount", () => {
    const binds = buildBinds("/srv/myrmidon/bots", "agent-a");
    expect(binds[0]).toContain(":/data/hermes");
    expect(mountRootSegment({ hostSuffix: "hermes", containerPath: "/data/hermes" })).toBe("data/hermes");
    expect(mountRootSegment({ hostSuffix: "workspace", containerPath: "/workspace" })).toBe("workspace");
    expect(mountRootSegment({ hostSuffix: "scratch", containerPath: "/scratch" })).toBe("scratch");
  });
});

describe("resolveProfileFileTarget", () => {
  function file(path: string): CompiledProfileFile {
    return { path, content: "", mode: 0o644, secret: false };
  }

  it("routes hermes/workspace/scratch prefixes to their mount", () => {
    expect(resolveProfileFileTarget(file("hermes/config.yaml"))).toEqual({
      mount: { hostSuffix: "hermes", containerPath: "/data/hermes" },
      relativePath: "config.yaml",
    });
    expect(resolveProfileFileTarget(file("workspace/AGENTS.md")).relativePath).toBe("AGENTS.md");
    expect(resolveProfileFileTarget(file("scratch/tmp/x")).relativePath).toBe("tmp/x");
  });

  it("rejects any other top-level segment (a compiler bug, not user input)", () => {
    expect(() => resolveProfileFileTarget(file("etc/passwd"))).toThrow(BotContainerTemplateError);
    expect(() => resolveProfileFileTarget(file("hermes"))).toThrow(BotContainerTemplateError); // no relative path
  });
});

describe("buildLabels", () => {
  it("always wins over caller-supplied labels for the four identification keys", () => {
    const labels = buildLabels(
      {
        botKey: "agent-a",
        image: "myrmidon-hermes:1.1.0",
        labels: {
          [BOT_LABEL_KEYS.bot]: "someone-else",
          [BOT_LABEL_KEYS.image]: "evil:latest",
          group: "team-b",
        },
      },
      { restartHash: "r1", filesHash: "f1" },
    );
    expect(labels).toEqual({
      group: "team-b",
      [BOT_LABEL_KEYS.bot]: "agent-a",
      [BOT_LABEL_KEYS.restartHash]: "r1",
      [BOT_LABEL_KEYS.filesHash]: "f1",
      [BOT_LABEL_KEYS.image]: "myrmidon-hermes:1.1.0",
    });
  });
});
