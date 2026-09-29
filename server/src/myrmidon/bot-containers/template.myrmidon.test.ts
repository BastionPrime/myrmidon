import { describe, expect, it } from "vitest";
import {
  assertBotRuntimeContract,
  BOT_KEY_PATTERN,
  BOT_LABEL_KEYS,
  BOT_RUNTIME_CONTRACT_LABEL,
  BotContainerTemplateError,
  buildBinds,
  buildLabels,
  containerNameFor,
  helperContainerNameFor,
  isImageAllowed,
  isUnderManagedDir,
  mountRootSegment,
  parseImageAllowlist,
  replacementContainerNameFor,
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

describe("helperContainerNameFor / replacementContainerNameFor", () => {
  it("can never equal another bot's own container name", () => {
    // "myrmidon-bot-<key>-helper" would collide with bot key "<key>-helper"; a
    // "." cannot appear in a bot key, so these names are outside that space.
    expect(helperContainerNameFor("agent-a")).toBe("myrmidon-bot-agent-a.helper");
    expect(replacementContainerNameFor("agent-a")).toBe("myrmidon-bot-agent-a.next");
    for (const name of [helperContainerNameFor("agent-a"), replacementContainerNameFor("agent-a")]) {
      const suffix = name.slice("myrmidon-bot-".length);
      expect(BOT_KEY_PATTERN.test(suffix)).toBe(false);
    }
  });

  it("rejects an invalid bot key", () => {
    expect(() => helperContainerNameFor("../x")).toThrow(BotContainerTemplateError);
    expect(() => replacementContainerNameFor("A")).toThrow(BotContainerTemplateError);
  });
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
    expect(() => resolveProfileFileTarget(file("hermes/"))).toThrow(BotContainerTemplateError);
  });

  it.each([
    "hermes/../../etc/passwd",
    "hermes/../.myrmidon/applied.json", // would land on the live marker once Docker cleans the staged path
    "hermes/../../workspace/x", // would reach another volume, past the staging directory
    "hermes/config/../../../etc/passwd",
    "workspace/..",
    "hermes/./config.yaml",
    "hermes/.",
    "hermes//config.yaml",
    "hermes/config.yaml/",
  ])("rejects a '..' / '.' / empty segment anywhere in the relative path: %j", (path) => {
    expect(() => resolveProfileFileTarget(file(path))).toThrow(BotContainerTemplateError);
  });

  it("rejects a backslash, a NUL and other control characters", () => {
    expect(() => resolveProfileFileTarget(file("hermes/..\\..\\etc"))).toThrow(/backslash/);
    expect(() => resolveProfileFileTarget(file("hermes/skills\\x.md"))).toThrow(/backslash/);
    expect(() => resolveProfileFileTarget(file("hermes/config.yaml\u0000.png"))).toThrow(/control character/);
    expect(() => resolveProfileFileTarget(file("hermes/a\nhermes/.env"))).toThrow(/control character/);
    expect(() => resolveProfileFileTarget(file("hermes/a\u007f"))).toThrow(/control character/);
  });

  it.each([
    "hermes/.myrmidon/applied.json", // the applied-state marker itself
    "hermes/.myrmidon",
    "hermes/.myrmidon-next-0011223344556677/config.yaml", // another apply's staging
    "hermes/.myrmidon-apply-0011223344556677/applied.json",
    "hermes/.myrmidon-old-0011223344556677/0",
    "hermes/.myrmidon-marker-next/x",
    "workspace/.myrmidon-next-ab/AGENTS.md",
    "hermes/skills-board/x/.myrmidon/y", // reserved anywhere, not only at the mount root
  ])("rejects a path into the driver's reserved bookkeeping: %j", (path) => {
    expect(() => resolveProfileFileTarget(file(path))).toThrow(/reserved/);
  });

  it("still accepts ordinary names that merely contain dots, including a leading dot", () => {
    expect(resolveProfileFileTarget(file("workspace/notes.v2.md")).relativePath).toBe("notes.v2.md");
    expect(resolveProfileFileTarget(file("hermes/.env")).relativePath).toBe(".env");
    expect(resolveProfileFileTarget(file("hermes/skills-board/a..b/SKILL.md")).relativePath).toBe("skills-board/a..b/SKILL.md");
  });
});

describe("isUnderManagedDir", () => {
  it("covers the compiler-owned skills directory and everything under it, nothing else", () => {
    expect(isUnderManagedDir("hermes/skills-board")).toBe(true);
    expect(isUnderManagedDir("hermes/skills-board/a/SKILL.md")).toBe(true);
    expect(isUnderManagedDir("hermes/skills-board-other/a")).toBe(false);
    expect(isUnderManagedDir("hermes/skills/a/SKILL.md")).toBe(false);
    expect(isUnderManagedDir("workspace/AGENTS.md")).toBe(false);
  });
});

describe("buildLabels", () => {
  it("always wins over caller-supplied labels for the identification keys, and cannot be tagged a helper", () => {
    const labels = buildLabels({
      botKey: "agent-a",
      image: "myrmidon-hermes:1.1.0",
      labels: {
        [BOT_LABEL_KEYS.bot]: "someone-else",
        [BOT_LABEL_KEYS.image]: "evil:latest",
        [BOT_LABEL_KEYS.helper]: "agent-a",
        group: "team-b",
      },
    });
    expect(labels).toEqual({
      group: "team-b",
      [BOT_LABEL_KEYS.bot]: "agent-a",
      [BOT_LABEL_KEYS.image]: "myrmidon-hermes:1.1.0",
    });
  });

  it("carries no profile hashes: a label is fixed at creation and can never mean 'applied'", () => {
    const labels = buildLabels({ botKey: "agent-a", image: "myrmidon-hermes:1.1.0" });
    expect(Object.keys(labels).sort()).toEqual([BOT_LABEL_KEYS.bot, BOT_LABEL_KEYS.image].sort());
    expect(Object.keys(labels).some((key) => key.includes("hash"))).toBe(false);
  });
});

describe("assertBotRuntimeContract", () => {
  it("accepts an image that declares a supported contract, whatever else it is labelled with", () => {
    expect(() =>
      assertBotRuntimeContract("myrmidon-hermes:1.1.0", {
        "org.opencontainers.image.title": "myrmidon-hermes",
        [BOT_RUNTIME_CONTRACT_LABEL]: "1",
      }),
    ).not.toThrow();
  });

  const refused: Array<{ label: string; labels: Record<string, string> | null | undefined }> = [
    { label: "no labels (Docker's null)", labels: null },
    { label: "no labels (absent)", labels: undefined },
    { label: "other labels only", labels: { "org.opencontainers.image.title": "myrmidon-hermes" } },
    { label: "an empty contract", labels: { [BOT_RUNTIME_CONTRACT_LABEL]: "" } },
    { label: "an unknown contract", labels: { [BOT_RUNTIME_CONTRACT_LABEL]: "2" } },
  ];
  it.each(refused)("refuses an image with $label", ({ labels }) => {
    expect(() => assertBotRuntimeContract("myrmidon-hermes:1.0.0", labels)).toThrow(BotContainerTemplateError);
  });
});
