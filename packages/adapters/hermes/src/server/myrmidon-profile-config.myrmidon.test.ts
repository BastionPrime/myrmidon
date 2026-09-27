import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import {
  applyCardModelsToConfigYaml,
  materializeHermesRunModels,
  readHermesCardModels,
} from "./myrmidon-profile-config.js";

const PROFILE_CONFIG = [
  "model:",
  "  default: profile-model",
  "  provider: custom",
  "auxiliary:",
  "  vision:",
  "    provider: auto",
  "    model: \"\"",
  "    timeout: 30",
  "stt:",
  "  enabled: true",
  "  provider: openai",
  "  openai:",
  "    model: whisper-1",
  "    language: \"\"",
  "tts:",
  "  provider: edge",
  "fallback_model:",
  "- provider: custom",
  "  model: old-fallback",
  "agent:",
  "  max_turns: 60",
  "  reasoning_effort: low",
  "memory:",
  "  provider: hindsight",
  "",
].join("\n");

const FULL_CARD = {
  model: "text-model",
  effort: "high",
  models: {
    vision: "vision-model",
    video: "video-model",
    stt: "stt-model",
    tts: "tts-model",
    fallbacks: ["fallback-a", "fallback-b"],
  },
};

describe("myrmidon(M1) card models to config.yaml", () => {
  it("writes every supported field and keeps the rest of the profile", () => {
    const result = applyCardModelsToConfigYaml(PROFILE_CONFIG, readHermesCardModels(FULL_CARD), {
      provider: "custom",
    });
    expect(result.configYaml).toBe(
      [
        "model:",
        '  default: "text-model"',
        "  provider: custom",
        "auxiliary:",
        "  vision:",
        "    provider: auto",
        '    model: "vision-model"',
        "    timeout: 30",
        "stt:",
        "  enabled: true",
        "  provider: openai",
        "  openai:",
        '    model: "stt-model"',
        '    language: ""',
        "tts:",
        "  provider: edge",
        "  edge:",
        '    model: "tts-model"',
        "fallback_model:",
        '  - provider: "custom"',
        '    model: "fallback-a"',
        '  - provider: "custom"',
        '    model: "fallback-b"',
        "agent:",
        "  max_turns: 60",
        '  reasoning_effort: "high"',
        "memory:",
        "  provider: hindsight",
        "",
      ].join("\n"),
    );
    expect(result.applied).toEqual([
      "model.default",
      "auxiliary.vision.model",
      "stt.openai.model",
      "tts.edge.model",
      "fallback_model",
      "agent.reasoning_effort",
    ]);
    expect(result.warnings).toEqual([expect.stringContaining("video model")]);
  });

  it("creates missing sections in an empty profile", () => {
    const result = applyCardModelsToConfigYaml("", { text: "text-model", vision: "vision-model", reasoningEffort: "low" });
    expect(result.configYaml).toBe(
      [
        "model:",
        '  default: "text-model"',
        "auxiliary:",
        "  vision:",
        '    model: "vision-model"',
        "agent:",
        '  reasoning_effort: "low"',
        "",
      ].join("\n"),
    );
  });

  it("empty card fields leave the profile untouched", () => {
    const models = readHermesCardModels({ model: "", effort: "", models: { vision: " ", fallbacks: [""] } });
    const result = applyCardModelsToConfigYaml(PROFILE_CONFIG, models);
    expect(result.configYaml).toBe(PROFILE_CONFIG);
    expect(result.applied).toEqual([]);
  });

  it("warns instead of failing on fields Hermes cannot take", () => {
    const result = applyCardModelsToConfigYaml("model:\n  default: x\n", {
      stt: "stt-model",
      tts: "tts-model",
      fallbacks: ["fallback-a"],
      video: "video-model",
      reasoningEffort: "turbo",
    });
    expect(result.applied).toEqual([]);
    expect(result.configYaml).toBe("model:\n  default: x\n");
    expect(result.warnings).toHaveLength(5);
  });

  it("leaves unsupported YAML shapes alone with a warning", () => {
    const flow = "model: {default: x, provider: custom}\nagent:\n    reasoning_effort: low\n";
    const result = applyCardModelsToConfigYaml(flow, { text: "text-model", reasoningEffort: "high" });
    expect(result.configYaml).toBe(flow);
    expect(result.warnings).toEqual([
      expect.stringContaining("model.default"),
      expect.stringContaining("agent.reasoning_effort"),
    ]);
  });
});

describe("myrmidon(M1) run-scoped config.yaml", () => {
  let root = "";
  let profile = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-m1-"));
    profile = path.join(root, "profiles", "agent-a");
    await fs.mkdir(path.join(profile, "skills"), { recursive: true });
    await fs.writeFile(path.join(profile, "config.yaml"), PROFILE_CONFIG, "utf8");
    vi.mocked(serverUtils.runChildProcess).mockClear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null and creates nothing when the card sets no models", async () => {
    const result = await materializeHermesRunModels({
      config: {},
      hermesHome: profile,
      homeDir: root,
      runScopedHome: false,
      runId: "run-a",
    });
    expect(result).toBeNull();
  });

  it("run sees the card models; the persistent profile is not changed", async () => {
    let seenHome = "";
    let seenConfig = "";
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts) => {
      seenHome = opts.env.HERMES_HOME!;
      seenConfig = await fs.readFile(path.join(seenHome, "config.yaml"), "utf8");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1, startedAt: "" } as never;
    });
    const logs: string[] = [];
    const config = {
      hermesCommand: "/usr/bin/hermes",
      provider: "custom",
      env: { HERMES_HOME: profile },
      ...FULL_CARD,
    };
    const result = await execute({
      runId: "run-a",
      agent: { id: "agent-a", companyId: "company-a", name: "agent-a", adapterType: "hermes_local", adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config,
      context: {},
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);

    // The run starts even though the video model is not supported.
    expect(serverUtils.runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toContain("Hermes has no separate video model setting");

    expect(seenHome).not.toBe(profile);
    expect(path.basename(seenHome)).toBe("agent-a");
    expect(seenConfig).toContain('default: "text-model"');
    expect(seenConfig).toContain('model: "vision-model"');
    expect(seenConfig).toContain('reasoning_effort: "high"');
    expect(seenConfig).toContain('model: "fallback-a"');

    // Persistent profile: same config, no new files; run home removed.
    expect(await fs.readFile(path.join(profile, "config.yaml"), "utf8")).toBe(PROFILE_CONFIG);
    expect((await fs.readdir(profile)).sort()).toEqual(["config.yaml", "skills"]);
    await expect(fs.access(seenHome)).rejects.toThrow();
  });

  it("edits the P4 run-scoped copy in place", async () => {
    const runHome = path.join(root, "run-home");
    await fs.mkdir(runHome, { recursive: true });
    await fs.writeFile(path.join(runHome, "config.yaml"), PROFILE_CONFIG, "utf8");
    const result = await materializeHermesRunModels({
      config: { model: "text-model" },
      hermesHome: runHome,
      homeDir: root,
      runScopedHome: true,
      runId: "run-a",
    });
    expect(result?.hermesHome).toBe(runHome);
    expect(await fs.readFile(path.join(runHome, "config.yaml"), "utf8")).toContain('default: "text-model"');
    await result?.cleanup();
    // Cleanup of a P4 home belongs to P4.
    await expect(fs.access(runHome)).resolves.toBeUndefined();
  });
});
