/**
 * Guard for myrmidon(S2-hostcred): the host's GitHub credentials never reach a
 * run environment.
 *
 * The behavioral half (`describe("run environment …")`) drives the vendor's own
 * `prepareGitHubExecutionEnvironment` with the mode the heartbeat now resolves,
 * against a host process environment that carries a token, and shows both
 * directions: vendor host mode copies the token in, our mode does not. The
 * wiring half reads `services/heartbeat.ts` and fails when the labeled call
 * sites disappear — that is the red half of the pair.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareGitHubExecutionEnvironment } from "@paperclipai/adapter-utils/execution-target";

import {
  HOST_GITHUB_CREDENTIALS_ENV,
  HOST_GITHUB_CREDENTIAL_ENV_NAMES,
  filterHostGitHubCredentialEnv,
  hostGitHubCredentialTransferEnabled,
  isHostGitHubCredentialEnvKey,
  resolveRunHostGitHubCredentials,
} from "./host-github-credentials.js";

const HEARTBEAT_PATH = fileURLToPath(
  new URL("../../src/services/heartbeat.ts", import.meta.url),
);
const EXECUTION_TARGET_PATH = fileURLToPath(
  new URL(
    "../../../packages/adapter-utils/src/execution-target.ts",
    import.meta.url,
  ),
);

describe("myrmidon(S2-hostcred) flag: the vendor host mode is opt-in only", () => {
  const saved = process.env[HOST_GITHUB_CREDENTIALS_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[HOST_GITHUB_CREDENTIALS_ENV];
    else process.env[HOST_GITHUB_CREDENTIALS_ENV] = saved;
  });

  it("unset: the run takes the managed side even when the vendor would pick host mode", () => {
    delete process.env[HOST_GITHUB_CREDENTIALS_ENV];
    expect(hostGitHubCredentialTransferEnabled()).toBe(false);
    expect(resolveRunHostGitHubCredentials(true)).toBe(false);
    expect(resolveRunHostGitHubCredentials(false)).toBe(false);
  });

  it("only the exact value 1 restores the vendor host mode", () => {
    process.env[HOST_GITHUB_CREDENTIALS_ENV] = "1";
    expect(hostGitHubCredentialTransferEnabled()).toBe(true);
    expect(resolveRunHostGitHubCredentials(true)).toBe(true);
    // The switch restores vendor behavior; it never forces host mode on a run
    // the vendor itself would have kept managed.
    expect(resolveRunHostGitHubCredentials(false)).toBe(false);
  });

  it("a typo stays on the closed side (true/yes/on/padding must not reopen the transfer)", () => {
    for (const value of ["true", "yes", "on", "case", " 1", "1 ", "1x", "01", ""]) {
      process.env[HOST_GITHUB_CREDENTIALS_ENV] = value;
      expect(
        hostGitHubCredentialTransferEnabled(),
        `${HOST_GITHUB_CREDENTIALS_ENV}=${JSON.stringify(value)} must not enable host mode`,
      ).toBe(false);
      expect(resolveRunHostGitHubCredentials(true)).toBe(false);
    }
  });
});

describe("myrmidon(S2-hostcred) env filter", () => {
  const hostileEnv: Record<string, unknown> = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    PAPERCLIP_API_KEY: "pcp_run_key",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_AUTHOR_NAME: "itkadr-git",
    GIT_AUTHOR_EMAIL: "itkadr@gmail.com",
    GH_TOKEN: "ghp_token_0001",
    GITHUB_TOKEN: "ghp_token_0002",
    GH_ENTERPRISE_TOKEN: "ghp_token_0003",
    GITHUB_ENTERPRISE_TOKEN: "ghp_token_0004",
    PAPERCLIP_GIT_TOKEN: "pcp_git_0001",
    GH_CONFIG_DIR: "/home/operator/.config/gh",
    GIT_ASKPASS: "/usr/bin/askpass",
    SSH_ASKPASS: "/usr/bin/askpass",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    GIT_SSH_COMMAND: "ssh -i /home/operator/.ssh/id_ed25519",
    GIT_SSH: "/home/operator/bin/git-ssh",
    PAPERCLIP_GITHUB_HOST_HOME: "/home/operator",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "/home/operator/bin/host-credential-helper",
  };

  it("drops every host credential name, including per-entry git config", () => {
    const filtered = filterHostGitHubCredentialEnv(hostileEnv);
    for (const name of HOST_GITHUB_CREDENTIAL_ENV_NAMES) {
      expect(filtered[name], `${name} must not survive the filter`).toBeUndefined();
    }
    expect(filtered.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(filtered.GIT_CONFIG_VALUE_0).toBeUndefined();
    // No token value anywhere in the surviving map.
    for (const value of Object.values(filtered)) {
      expect(String(value)).not.toMatch(/ghp_token|pcp_git/);
    }
  });

  it("keeps unrelated names and the neutral git pointers the broker sets itself", () => {
    const filtered = filterHostGitHubCredentialEnv(hostileEnv);
    expect(filtered.PATH).toBe("/usr/bin:/bin");
    expect(filtered.HOME).toBe("/home/operator");
    expect(filtered.PAPERCLIP_API_KEY).toBe("pcp_run_key");
    expect(filtered.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(filtered.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(filtered.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(filtered.GIT_CONFIG_COUNT).toBe("1");
    expect(filtered.GIT_AUTHOR_NAME).toBe("itkadr-git");
    expect(filtered.GIT_AUTHOR_EMAIL).toBe("itkadr@gmail.com");
  });

  it("classifies exactly the credential names, not the identity or pointer names", () => {
    for (const name of HOST_GITHUB_CREDENTIAL_ENV_NAMES) {
      expect(isHostGitHubCredentialEnvKey(name), name).toBe(true);
    }
    for (const name of [
      "PATH",
      "HOME",
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_GITHUB_AUTH_MODE",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
    ]) {
      expect(isHostGitHubCredentialEnvKey(name), name).toBe(false);
    }
  });
});

describe("myrmidon(S2-hostcred) run environment", () => {
  const TOUCHED = ["GITHUB_TOKEN", "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "HOME"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED) saved[key] = process.env[key];
    process.env.GITHUB_TOKEN = "ghp_host_only_token_0001";
    process.env.GH_CONFIG_DIR = "/home/operator/.config/gh";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.HOME = "/home/operator";
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  it("vendor host mode does copy the host token in (the transfer this item closes)", async () => {
    const vendorEnv = await prepareGitHubExecutionEnvironment({
      target: null,
      cwd: process.cwd(),
      env: {},
      hostCredentials: true,
      networkAccess: true,
    });
    expect(vendorEnv.GITHUB_TOKEN).toBe("ghp_host_only_token_0001");
    expect(vendorEnv.GH_CONFIG_DIR).toBe("/home/operator/.config/gh");
    expect(vendorEnv.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(vendorEnv.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
  });

  it("the run the heartbeat prepares carries no host credential name", async () => {
    const runEnv = filterHostGitHubCredentialEnv(
      await prepareGitHubExecutionEnvironment({
        target: null,
        cwd: process.cwd(),
        env: {},
        hostCredentials: resolveRunHostGitHubCredentials(true),
        networkAccess: true,
      }),
    );
    for (const name of HOST_GITHUB_CREDENTIAL_ENV_NAMES) {
      expect(runEnv[name], `${name} leaked into the run environment`).toBeUndefined();
    }
    expect(runEnv.GITHUB_TOKEN).toBeUndefined();
    expect(runEnv.PAPERCLIP_GITHUB_AUTH_MODE).toBe("managed");
    expect(JSON.stringify(runEnv)).not.toContain("ghp_host_only_token_0001");
  });
});

describe("myrmidon(S2-hostcred) wiring guards", () => {
  it("covers every credential name the vendor host probe copies", () => {
    const probe = readFileSync(EXECUTION_TARGET_PATH, "utf8");
    for (const name of HOST_GITHUB_CREDENTIAL_ENV_NAMES) {
      expect(
        probe.includes(name),
        `the host probe in execution-target.ts no longer names ${name}; re-sync HOST_GITHUB_CREDENTIAL_ENV_NAMES`,
      ).toBe(true);
    }
  });

  it("heartbeat routes the run mode through the myrmidon decision, not the vendor's alone", () => {
    const heartbeat = readFileSync(HEARTBEAT_PATH, "utf8");
    expect(heartbeat).toContain("myrmidon(S2-hostcred)");
    expect(heartbeat).toContain("resolveRunHostGitHubCredentials(useHostGitHub)");
    expect(heartbeat).toContain("managedGitHubCredentials: !runHostGitHubCredentials,");
    expect(heartbeat).toContain("hostCredentials: runHostGitHubCredentials,");
    expect(heartbeat).toContain(
      "context.githubAuthenticationMode = runHostGitHubCredentials ? \"host\" : \"managed\";",
    );
    expect(heartbeat).toContain("if (!runHostGitHubCredentials) {");
    expect(heartbeat).toContain("filterHostGitHubCredentialEnv(gitExecutionEnv)");
    // The vendor's un-gated host decision must not come back unnoticed.
    expect(heartbeat).not.toContain("hostCredentials: useHostGitHub,");
    expect(heartbeat).not.toContain("managedGitHubCredentials: !useHostGitHub,");
  });
});