/**
 * myrmidon(S2): real adapter execute() paths spawn a fake CLI that records the
 * names of its environment variables. Server secrets must not reach the run;
 * adapterConfig.env and the run's own PAPERCLIP_* variables must.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import { execute as executeHermes } from "@paperclipai/hermes-paperclip-adapter/server";

// Obviously fake values: nothing here is a real credential.
const FAKE_SERVER_SECRETS: Record<string, string> = {
  DATABASE_URL: "postgres://fake-user:fake-db-password@db.example.com:5432/app",
  BETTER_AUTH_SECRET: "fake-better-auth-secret-value",
  PAPERCLIP_AGENT_JWT_SECRET: "fake-agent-jwt-secret-value",
  PAPERCLIP_DECISION_SIGNING_SECRET: "fake-decision-signing-secret",
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "fake-tool-action-signing-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "fake-secrets-master-key-value",
};

async function writeEnvRecordingCli(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (!process.stdin.isTTY) { try { fs.readFileSync(0); } catch {} }
const capturePath = process.env.MYRMIDON_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.appendFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), names: Object.keys(process.env).sort() }) + "\\n");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "session-1" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function readInvocations(capturePath: string): Promise<Array<{ argv: string[]; names: string[] }>> {
  const raw = await fs.readFile(capturePath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; names: string[] });
}

type AdapterCase = {
  label: string;
  adapterType: string;
  execute: (ctx: AdapterExecutionContext) => Promise<unknown>;
  config: (commandPath: string) => Record<string, unknown>;
};

const CASES: AdapterCase[] = [
  {
    label: "hermes_local",
    adapterType: "hermes_local",
    execute: executeHermes,
    config: (commandPath) => ({ hermesCommand: commandPath, persistSession: false }),
  },
  {
    label: "codex_local",
    adapterType: "codex_local",
    execute: executeCodex,
    config: (commandPath) => ({ engine: "cli", command: commandPath }),
  },
  {
    label: "claude_local",
    adapterType: "claude_local",
    execute: executeClaude,
    config: (commandPath) => ({ engine: "cli", command: commandPath }),
  },
];

describe("myrmidon(S2) adapter runs do not inherit server secrets", () => {
  const saved: Record<string, string | undefined> = {};
  let root = "";

  beforeEach(async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "myrmidon-run-env-"));
    const overrides: Record<string, string | undefined> = {
      ...FAKE_SERVER_SECRETS,
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: undefined,
      PAPERCLIP_IN_WORKTREE: undefined,
      CODEX_HOME: undefined,
      MYRMIDON_RUN_ENV_ALLOW: undefined,
      ANTHROPIC_API_KEY: undefined,
      XAI_API_KEY: undefined,
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify(["http://127.0.0.1:3100/api"]),
    };
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function runAdapter(testCase: AdapterCase, extraConfig: Record<string, unknown> = {}) {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = path.join(root, `fake-${testCase.label}`);
    const capturePath = path.join(root, `${testCase.label}.jsonl`);
    await writeEnvRecordingCli(commandPath);
    const config = {
      ...testCase.config(commandPath),
      cwd: workspace,
      env: {
        MYRMIDON_TEST_CAPTURE_PATH: capturePath,
        AGENT_CONFIG_VAR: "from-adapter-config",
        // Agent-bound provider key: must still reach the run.
        OPENAI_API_KEY: "fake-agent-bound-key",
      },
      promptTemplate: "Do the task.",
      ...extraConfig,
    };
    await testCase.execute({
      runId: "run-a",
      agent: {
        id: "agent-a",
        companyId: "company-a",
        name: "agent-a",
        adapterType: testCase.adapterType,
        adapterConfig: config,
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config,
      context: {},
      authToken: "fake-run-jwt",
      onLog: async () => {},
    } as unknown as AdapterExecutionContext);
    const invocations = await readInvocations(capturePath);
    expect(invocations.length).toBeGreaterThan(0);
    return invocations;
  }

  for (const testCase of CASES) {
    it(`${testCase.label}: run does not see the database password and server secrets`, async () => {
      const invocations = await runAdapter(testCase);
      for (const { names } of invocations) {
        for (const secret of Object.keys(FAKE_SERVER_SECRETS)) {
          expect(names).not.toContain(secret);
        }
      }
      const agentRun = invocations[invocations.length - 1]!;
      expect(agentRun.names).toContain("AGENT_CONFIG_VAR");
      expect(agentRun.names).toContain("OPENAI_API_KEY");
      expect(agentRun.names).toContain("PAPERCLIP_RUN_ID");
      expect(agentRun.names).toContain("PAPERCLIP_API_KEY");
    });

    it(`${testCase.label}: inheritProcessEnv restores the server environment`, async () => {
      const invocations = await runAdapter(testCase, { inheritProcessEnv: true });
      const agentRun = invocations[invocations.length - 1]!;
      expect(agentRun.names).toContain("DATABASE_URL");
      expect(agentRun.names).toContain("BETTER_AUTH_SECRET");
    });
  }

  it("provider credentials of the adapter's own provider are inherited, others are not", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-server-anthropic-key";
    process.env.XAI_API_KEY = "fake-server-xai-key";
    try {
      const claudeRun = (await runAdapter(CASES[2]!)).at(-1)!;
      expect(claudeRun.names).toContain("ANTHROPIC_API_KEY");
      expect(claudeRun.names).not.toContain("XAI_API_KEY");
      expect(claudeRun.names).not.toContain("DATABASE_URL");
      const hermesRun = (await runAdapter(CASES[0]!)).at(-1)!;
      expect(hermesRun.names).toContain("ANTHROPIC_API_KEY");
      expect(hermesRun.names).not.toContain("XAI_API_KEY");
      expect(hermesRun.names).not.toContain("BETTER_AUTH_SECRET");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.XAI_API_KEY;
    }
  });

  for (const testCase of CASES) {
    it(`${testCase.label}: keeps the server API candidate list, drops PAPERCLIP_*_SECRET`, async () => {
      for (const inheritProcessEnv of [false, true]) {
        const agentRun = (await runAdapter(testCase, { inheritProcessEnv })).at(-1)!;
        expect(agentRun.names).toContain("PAPERCLIP_RUNTIME_API_CANDIDATES_JSON");
        for (const secret of [
          "PAPERCLIP_AGENT_JWT_SECRET",
          "PAPERCLIP_DECISION_SIGNING_SECRET",
          "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
          "PAPERCLIP_SECRETS_MASTER_KEY",
        ]) {
          expect(agentRun.names).not.toContain(secret);
        }
      }
    });
  }

  it("MYRMIDON_RUN_ENV_ALLOW adds a server variable to an adapter run", async () => {
    process.env.MYRMIDON_RUN_ENV_ALLOW = "BETTER_AUTH_SECRET";
    const invocations = await runAdapter(CASES[0]!);
    const agentRun = invocations[invocations.length - 1]!;
    expect(agentRun.names).toContain("BETTER_AUTH_SECRET");
    expect(agentRun.names).not.toContain("DATABASE_URL");
  });
});
