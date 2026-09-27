import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";

// Obviously fake values: nothing here is a real credential.
const FAKE_SERVER_SECRETS: Record<string, string> = {
  DATABASE_URL: "postgres://fake-user:fake-db-password@db.example.com:5432/app",
  BETTER_AUTH_SECRET: "fake-better-auth-secret-value",
  PAPERCLIP_AGENT_JWT_SECRET: "fake-agent-jwt-secret-value",
  PAPERCLIP_DECISION_SIGNING_SECRET: "fake-decision-signing-secret",
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "fake-tool-action-signing-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "fake-secrets-master-key-value",
  AWS_SECRET_ACCESS_KEY: "fake-aws-secret-access-key",
};

// Fake adapter CLI: prints the names of its environment variables.
const PRINT_ENV_NAMES = ["-e", "process.stdout.write(Object.keys(process.env).sort().join('\\n'))"];

async function spawnedEnvNames(options: { env: Record<string, string>; inheritProcessEnv?: boolean }) {
  const result = await runChildProcess("run-env-test", process.execPath, PRINT_ENV_NAMES, {
    cwd: process.cwd(),
    env: options.env,
    timeoutSec: 20,
    graceSec: 1,
    onLog: async () => {},
    inheritProcessEnv: options.inheritProcessEnv,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.split("\n");
}

describe("myrmidon(S2) run process does not inherit server secrets", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    for (const [key, value] of Object.entries(FAKE_SERVER_SECRETS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    saved.MYRMIDON_RUN_ENV_ALLOW = process.env.MYRMIDON_RUN_ENV_ALLOW;
    delete process.env.MYRMIDON_RUN_ENV_ALLOW;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("run does not see the database password and other server secrets", async () => {
    const names = await spawnedEnvNames({
      env: { AGENT_CONFIG_VAR: "from-adapter-config", PAPERCLIP_RUN_ID: "run-a" },
    });
    for (const secret of Object.keys(FAKE_SERVER_SECRETS)) {
      expect(names).not.toContain(secret);
    }
    expect(names).toContain("AGENT_CONFIG_VAR");
    expect(names).toContain("PAPERCLIP_RUN_ID");
    expect(names).toContain("PATH");
  });

  it("MYRMIDON_RUN_ENV_ALLOW adds a server variable to the run", async () => {
    process.env.MYRMIDON_RUN_ENV_ALLOW = "BETTER_AUTH_SECRET";
    const names = await spawnedEnvNames({ env: {} });
    expect(names).toContain("BETTER_AUTH_SECRET");
    expect(names).not.toContain("DATABASE_URL");
  });

  it("inheritProcessEnv restores the vendor behaviour", async () => {
    const names = await spawnedEnvNames({ env: {}, inheritProcessEnv: true });
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("BETTER_AUTH_SECRET");
    // Vendor still strips the server's PAPERCLIP_* secrets.
    expect(names).not.toContain("PAPERCLIP_AGENT_JWT_SECRET");
  });

  it("local execution target passes inheritProcessEnv through", async () => {
    const run = (inheritProcessEnv?: boolean) =>
      runAdapterExecutionTargetProcess("run-env-test", null, process.execPath, PRINT_ENV_NAMES, {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 20,
        graceSec: 1,
        onLog: async () => {},
        inheritProcessEnv,
      });
    expect((await run()).stdout.split("\n")).not.toContain("DATABASE_URL");
    expect((await run(true)).stdout.split("\n")).toContain("DATABASE_URL");
  });
});
