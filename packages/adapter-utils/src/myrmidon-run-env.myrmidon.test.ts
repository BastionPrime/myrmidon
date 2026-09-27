import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MYRMIDON_RUN_ENV_PROVIDER_ALLOW,
  buildMyrmidonRunEnv,
  filterMyrmidonInheritedEnv,
  parseRunEnvAllowList,
  readInheritProcessEnvFlag,
  reportDroppedRunEnvNames,
  resetReportedDroppedRunEnvNames,
} from "./myrmidon-run-env.js";

// Obviously fake values: nothing here is a real credential.
const SERVER_SECRETS = {
  DATABASE_URL: "postgres://fake-user:fake-db-password@db.example.com:5432/app",
  BETTER_AUTH_SECRET: "fake-better-auth-secret-value",
  PAPERCLIP_AGENT_JWT_SECRET: "fake-agent-jwt-secret-value",
  PAPERCLIP_DECISION_SIGNING_SECRET: "fake-decision-signing-secret",
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "fake-tool-action-signing-secret",
  PAPERCLIP_WORKSPACE_HANDOFF_SECRET: "fake-workspace-handoff-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "fake-secrets-master-key-value",
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/tmp/fake-master-key",
  AWS_ACCESS_KEY_ID: "FAKEACCESSKEYID",
  AWS_SECRET_ACCESS_KEY: "fake-aws-secret-access-key",
  ANTHROPIC_API_KEY: "fake-server-level-provider-key",
  OPENAI_API_KEY: "fake-server-level-provider-key-2",
} as const;

const SERVER_ENV: NodeJS.ProcessEnv = {
  ...SERVER_SECRETS,
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/agent-a",
  USER: "agent-a",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TZ: "UTC",
  HTTPS_PROXY: "http://proxy.example.com:3128",
  https_proxy: "http://proxy.example.com:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/example-ca.pem",
  PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: '["http://127.0.0.1:3100/api"]',
  CLAUDE_CONFIG_DIR: "/home/agent-a/.claude",
  PAPERCLIPAI_CMD: "node /opt/example/paperclipai.js",
  SOME_UNRELATED_SERVER_VAR: "value",
};

describe("myrmidon(S2) run environment", () => {
  beforeEach(() => {
    resetReportedDroppedRunEnvNames();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MYRMIDON_RUN_ENV_ALLOW;
  });

  it("does not pass server secrets to the run", () => {
    const env = buildMyrmidonRunEnv({ processEnv: SERVER_ENV, extraAllow: [] });
    for (const name of Object.keys(SERVER_SECRETS)) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env).not.toHaveProperty("SOME_UNRELATED_SERVER_VAR");
    expect(env).not.toHaveProperty("PAPERCLIPAI_CMD");
  });

  it("keeps allowed base variables, lower-case proxies and locale categories", () => {
    const env = buildMyrmidonRunEnv({ processEnv: SERVER_ENV, extraAllow: [] });
    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/agent-a",
      USER: "agent-a",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
      HTTPS_PROXY: "http://proxy.example.com:3128",
      https_proxy: "http://proxy.example.com:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/example-ca.pem",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: '["http://127.0.0.1:3100/api"]',
      CLAUDE_CONFIG_DIR: "/home/agent-a/.claude",
    });
  });

  it("passes adapterConfig.env (including agent-bound secrets) and run variables", () => {
    const env = buildMyrmidonRunEnv({
      processEnv: SERVER_ENV,
      extraAllow: [],
      adapterEnv: { AGENT_TOOL_TOKEN: "fake-agent-bound-secret", ANTHROPIC_API_KEY: "fake-agent-key" },
      runEnv: { PAPERCLIP_RUN_ID: "run-a", PAPERCLIP_API_KEY: "fake-run-jwt" },
    });
    expect(env.AGENT_TOOL_TOKEN).toBe("fake-agent-bound-secret");
    // An agent-level key explicitly configured on the card is the agent's own.
    expect(env.ANTHROPIC_API_KEY).toBe("fake-agent-key");
    expect(env.PAPERCLIP_RUN_ID).toBe("run-a");
    expect(env.PAPERCLIP_API_KEY).toBe("fake-run-jwt");
  });

  it("run variables win over adapterConfig.env", () => {
    const env = buildMyrmidonRunEnv({
      processEnv: {},
      adapterEnv: { PAPERCLIP_RUN_ID: "spoofed" },
      runEnv: { PAPERCLIP_RUN_ID: "run-a" },
    });
    expect(env.PAPERCLIP_RUN_ID).toBe("run-a");
  });

  it("MYRMIDON_RUN_ENV_ALLOW adds names", () => {
    process.env.MYRMIDON_RUN_ENV_ALLOW = " SOME_UNRELATED_SERVER_VAR , bad name, ";
    const env = buildMyrmidonRunEnv({ processEnv: SERVER_ENV });
    expect(env.SOME_UNRELATED_SERVER_VAR).toBe("value");
    expect(env).not.toHaveProperty("DATABASE_URL");
  });

  it("parses the allow list and ignores invalid names", () => {
    expect(parseRunEnvAllowList("A, B_2 ,,1BAD, with space ,_OK")).toEqual(["A", "B_2", "_OK"]);
    expect(parseRunEnvAllowList(undefined)).toEqual([]);
  });

  it("inheritProcessEnv restores the vendor behaviour", () => {
    const env = filterMyrmidonInheritedEnv(SERVER_ENV, { inheritProcessEnv: true });
    expect(env.DATABASE_URL).toBe(SERVER_SECRETS.DATABASE_URL);
    expect(env.SOME_UNRELATED_SERVER_VAR).toBe("value");
    // Vendor still strips the server's own PAPERCLIP_* variables.
    expect(env).not.toHaveProperty("PAPERCLIP_AGENT_JWT_SECRET");
    expect(env).not.toHaveProperty("PAPERCLIPAI_CMD");
    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3100");
    expect(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON).toBe('["http://127.0.0.1:3100/api"]');
  });

  it("honours inheritProcessEnv only when it is literally true", () => {
    expect(readInheritProcessEnvFlag({ inheritProcessEnv: true })).toBe(true);
    expect(readInheritProcessEnvFlag({ inheritProcessEnv: "true" })).toBe(false);
    expect(readInheritProcessEnvFlag({ inheritProcessEnv: 1 })).toBe(false);
    expect(readInheritProcessEnvFlag({})).toBe(false);
    expect(readInheritProcessEnvFlag(null)).toBe(false);
  });

  it("reports names of dropped variables, never values", () => {
    const onDropped = vi.fn();
    filterMyrmidonInheritedEnv(SERVER_ENV, { extraAllow: [], onDropped });
    const names = onDropped.mock.calls[0]![0] as string[];
    expect(names).toEqual(expect.arrayContaining(["DATABASE_URL", "BETTER_AUTH_SECRET"]));
    for (const value of Object.values(SERVER_SECRETS)) {
      expect(names).not.toContain(value);
    }
  });

  it("default report logs each dropped name once at debug level without values", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    reportDroppedRunEnvNames(["DATABASE_URL", "BETTER_AUTH_SECRET"]);
    reportDroppedRunEnvNames(["DATABASE_URL"]);
    expect(debug).toHaveBeenCalledTimes(1);
    const line = String(debug.mock.calls[0]![0]);
    expect(line).toContain("BETTER_AUTH_SECRET, DATABASE_URL");
    expect(line).not.toContain("fake-");
  });

  it("each adapter inherits its own provider credentials, never board secrets", () => {
    const env: NodeJS.ProcessEnv = {
      ...SERVER_ENV,
      XAI_API_KEY: "fake-xai-key",
      GEMINI_API_KEY: "fake-gemini-key",
    };
    const grok = filterMyrmidonInheritedEnv(env, { extraAllow: [], adapterType: "grok_local" });
    expect(grok.XAI_API_KEY).toBe("fake-xai-key");
    expect(grok).not.toHaveProperty("GEMINI_API_KEY");
    expect(grok).not.toHaveProperty("ANTHROPIC_API_KEY");

    const claude = filterMyrmidonInheritedEnv(env, { extraAllow: [], adapterType: "claude_local" });
    expect(claude.ANTHROPIC_API_KEY).toBe(SERVER_SECRETS.ANTHROPIC_API_KEY);
    expect(claude).not.toHaveProperty("XAI_API_KEY");

    for (const [adapterType, names] of Object.entries(MYRMIDON_RUN_ENV_PROVIDER_ALLOW)) {
      const inherited = filterMyrmidonInheritedEnv(env, { extraAllow: [], adapterType });
      for (const boardSecret of [
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "PAPERCLIP_AGENT_JWT_SECRET",
        "PAPERCLIP_DECISION_SIGNING_SECRET",
        "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
        "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
        "PAPERCLIP_SECRETS_MASTER_KEY",
        "AWS_SECRET_ACCESS_KEY",
      ]) {
        expect(names).not.toContain(boardSecret);
        expect(inherited, `${adapterType} ${boardSecret}`).not.toHaveProperty(boardSecret);
      }
    }
  });
});
