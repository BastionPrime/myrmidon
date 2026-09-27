import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute } from "@paperclipai/adapter-codex-local/server";
import { execute as cursorExecute } from "@paperclipai/adapter-cursor-local/server";
import { execute as geminiExecute } from "@paperclipai/adapter-gemini-local/server";
import { execute as grokExecute } from "@paperclipai/adapter-grok-local/server";
import { execute as kimiExecute } from "@paperclipai/adapter-kimi-local/server";
import { execute as opencodeExecute } from "@paperclipai/adapter-opencode-local/server";
import { execute as piExecute } from "@paperclipai/adapter-pi-local/server";
import {
  PROMPT_TOO_LARGE_FOR_ARGUMENT,
  resetCliFlagSupportCache,
} from "@paperclipai/adapter-utils/myrmidon-prompt-transport";

// myrmidon(H4): every local adapter must hand a large prompt to its CLI without
// putting it into argv (spawn E2BIG, and argv is visible in the process list).

const PROMPT_BYTES = 300 * 1024;
const HEAD = "PROMPT-TRANSPORT-HEAD";
const TAIL = "PROMPT-TRANSPORT-TAIL";
const LARGE_PROMPT = `${HEAD}\n${"x".repeat(PROMPT_BYTES)}\n${TAIL}`;

type Invocation = {
  argv: string[];
  stdin: string;
  promptFile: string | null;
  promptFileMode: number | null;
};

// One fake CLI for all adapters: it answers --help/--version probes, records
// argv, stdin and any --prompt-file content, and prints a harmless line.
const DEFAULT_HELP = "Usage: fake [OPTIONS]\n  --single <PROMPT>\n  --prompt-file <PATH>\n  --output-format <FORMAT>";

async function writeFakeCli(commandPath: string, capturePath: string, help = DEFAULT_HELP): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(${JSON.stringify(help)});
  process.exit(0);
}
if (argv.includes("--list-models")) {
  console.log("provider  model\\ngoogle    gemini-3-flash-preview");
  process.exit(0);
}
if (argv.includes("--version") || argv[0] === "version") {
  console.log("fake-cli 1.0.0");
  process.exit(0);
}
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const fileIndex = argv.indexOf("--prompt-file");
let promptFile = null;
let promptFileMode = null;
if (fileIndex >= 0) {
  promptFile = fs.readFileSync(argv[fileIndex + 1], "utf8");
  promptFileMode = fs.statSync(argv[fileIndex + 1]).mode & 0o777;
}
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv, stdin, promptFile, promptFileMode }) + "\\n");
console.log(JSON.stringify({ type: "result", subtype: "success", result: "ok" }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function readInvocations(capturePath: string): Promise<Invocation[]> {
  const raw = await fs.readFile(capturePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

type Execute = (ctx: never) => Promise<{ errorCode?: string | null; errorMessage?: string | null }>;

interface AdapterCase {
  name: string;
  adapterType: string;
  execute: Execute;
  config?: Record<string, unknown>;
}

const STDIN_OR_FILE_ADAPTERS: AdapterCase[] = [
  { name: "claude-local", adapterType: "claude_local", execute: claudeExecute as Execute, config: { engine: "cli" } },
  { name: "codex-local", adapterType: "codex_local", execute: codexExecute as Execute, config: { engine: "cli", env: { OPENAI_API_KEY: "test-key" } } },
  { name: "cursor-local", adapterType: "cursor", execute: cursorExecute as Execute, config: { model: "auto" } },
  { name: "gemini-local", adapterType: "gemini_local", execute: geminiExecute as Execute, config: { engine: "cli" } },
  { name: "grok-local", adapterType: "grok_local", execute: grokExecute as Execute },
  { name: "opencode-local", adapterType: "opencode_local", execute: opencodeExecute as Execute, config: { model: "openai/gpt-5" } },
  { name: "pi-local", adapterType: "pi_local", execute: piExecute as Execute, config: { model: "google/gemini-3-flash-preview" } },
];

let root: string;
let previousEnv: Record<string, string | undefined>;
const ISOLATED_ENV = ["HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PAPERCLIP_HOME"];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-prompt-transport-"));
  previousEnv = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]));
  process.env.HOME = path.join(root, "home");
  process.env.CODEX_HOME = path.join(root, "home", ".codex");
  process.env.XDG_CONFIG_HOME = path.join(root, "home", ".config");
  process.env.XDG_DATA_HOME = path.join(root, "home", ".local", "share");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  resetCliFlagSupportCache();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function runAdapter(adapter: AdapterCase, options: { help?: string; prompt?: string } = {}) {
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "bin", adapter.name);
  const capturePath = path.join(root, "capture.jsonl");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await writeFakeCli(commandPath, capturePath, options.help);
  const result = await adapter.execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "agent-a",
      adapterType: adapter.adapterType,
      adapterConfig: adapter.config ?? {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      ...adapter.config,
      command: commandPath,
      cwd: workspace,
      promptTemplate: options.prompt ?? LARGE_PROMPT,
      timeoutSec: 60,
    },
    context: {},
    authToken: "run-jwt-token",
    onLog: async () => {},
  } as never);
  return { result, invocations: await readInvocations(capturePath) };
}

describe("local adapters keep a 300 KB prompt out of argv", () => {
  for (const adapter of STDIN_OR_FILE_ADAPTERS) {
    it(`${adapter.name} delivers the whole prompt without argv`, async () => {
      const { invocations } = await runAdapter(adapter);
      const run = invocations.find((entry) =>
        entry.stdin.includes(HEAD) || (entry.promptFile ?? "").includes(HEAD) ||
        entry.argv.some((arg) => arg.includes(HEAD)));
      expect(run, "the CLI was launched with the prompt").toBeDefined();

      const argvBytes = run!.argv.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0);
      expect(run!.argv.join(" ")).not.toContain(HEAD);
      expect(argvBytes).toBeLessThan(PROMPT_BYTES);

      const received = run!.promptFile ?? run!.stdin;
      expect(received).toContain(HEAD);
      expect(received).toContain(TAIL);
      expect(received).toContain("x".repeat(PROMPT_BYTES));
      if (run!.promptFile !== null) expect(run!.promptFileMode).toBe(0o600);
    });
  }

  it("grok-local leaves no prompt file behind", async () => {
    const before = new Set(await fs.readdir(os.tmpdir()));
    await runAdapter(STDIN_OR_FILE_ADAPTERS.find((entry) => entry.name === "grok-local")!);
    const leaked = (await fs.readdir(os.tmpdir())).filter(
      (name) => !before.has(name) && name.startsWith("paperclip-prompt-"),
    );
    expect(leaked).toEqual([]);
  });

  it("grok-local without --prompt-file refuses an oversized argument prompt", async () => {
    // An older Grok CLI whose --help does not list --prompt-file.
    const grok = STDIN_OR_FILE_ADAPTERS.find((entry) => entry.name === "grok-local")!;
    const { result, invocations } = await runAdapter(grok, { help: "Usage: grok\n  --single <PROMPT>" });
    expect(invocations).toEqual([]);
    expect(result.errorCode).toBe(PROMPT_TOO_LARGE_FOR_ARGUMENT);
  });

  it("grok-local without --prompt-file keeps a small prompt as an argument", async () => {
    const grok = STDIN_OR_FILE_ADAPTERS.find((entry) => entry.name === "grok-local")!;
    const { invocations } = await runAdapter(grok, {
      help: "Usage: grok\n  --single <PROMPT>",
      prompt: "short prompt",
    });
    const run = invocations.find((entry) => entry.argv.includes("--single"));
    expect(run?.argv.join(" ")).toContain("short prompt");
    expect(run?.argv).not.toContain("--prompt-file");
  });

  it("kimi-local refuses an oversized argument prompt before launch", async () => {
    const { result, invocations } = await runAdapter({
      name: "kimi-local",
      adapterType: "kimi_local",
      execute: kimiExecute as Execute,
      config: { engine: "cli" },
    });
    expect(invocations).toEqual([]);
    expect(result.errorCode).toBe(PROMPT_TOO_LARGE_FOR_ARGUMENT);
    expect(result.errorMessage).toContain("Kimi CLI");
  });
});
