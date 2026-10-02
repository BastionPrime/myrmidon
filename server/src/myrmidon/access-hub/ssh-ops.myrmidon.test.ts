import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDeployToBody,
  applyRevokeFromBody,
  createSshDeployPort,
  readSshOpsSettings,
  DEFAULT_SSH_COMMAND_TIMEOUT_MS,
} from "./ssh-ops.js";

const SECRET_ID = "sec-1";
const FINGERPRINT = "SHA256:abc123";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEBODYEXAMPLEBODYEXAMPLE myrmidon-access-hub";

const HOST_A = "host-a.example.com";
const USER_A = "agent-a";

/** A fake authorized_keys file per host, driven by the fake execFile. */
const filesByHost = new Map<string, string>();

function fileOf(target: string): string {
  return filesByHost.get(target) ?? "";
}

function setFileOf(target: string, body: string): void {
  filesByHost.set(target, body);
}

/** The scratch tree the fake execFile writes the admin key into. */
const scratchRoot = mkdtempSync(join(tmpdir(), "ssh-ops-test-"));
const createdKeyFiles: string[] = [];

type ExecFile = (
  file: string,
  args: string[],
  opts: Record<string, unknown>,
) => Promise<{ stdout: string | Buffer }>;

function fakeExecFile(behavior: { failCommands?: RegExp; keyMaterial?: string }): ExecFile {
  return async (file, args) => {
    expect(file).toBe("ssh");
    // ssh arguments: [..., "user@host", command]
    const target = String(args[args.length - 2]);
    const command = String(args[args.length - 1]);
    const keyPathIndex = args.indexOf("-i");
    const keyPath = String(args[keyPathIndex + 1]);
    // The key file must exist and hold exactly the admin key at call time.
    expect(existsSync(keyPath)).toBe(true);
    createdKeyFiles.push(keyPath);
    if (behavior.keyMaterial !== undefined) {
      expect(readFileSync(keyPath, "utf8")).toBe(behavior.keyMaterial);
    }
    if (behavior.failCommands && behavior.failCommands.test(command)) {
      const err = new Error("ssh exited with code 255") as Error & { code?: string; killed?: boolean };
      err.code = "ETIMEDOUT";
      err.killed = true;
      throw err;
    }
    if (command.startsWith("cat ")) {
      return { stdout: fileOf(target) };
    }
    // The write command: base64 body → tmp → mv.
    const match = command.match(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d/);
    if (!match) throw new Error(`unexpected command: ${command}`);
    const body = Buffer.from(match[1], "base64").toString("utf8");
    setFileOf(target, body);
    return { stdout: "" };
  };
}

function baseDeps(behavior: { failCommands?: RegExp } = {}) {
  return {
    execFile: fakeExecFile(behavior) as never,
    scratchDir: () => scratchRoot,
    mkdtemp: async (prefix: string) => {
      // prefix already contains the scratch root path; make a unique dir.
      const dir = `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

const ADMIN_KEY = "-----BEGIN PRIVATE KEY-----\nTESTMATERIAL\n-----END PRIVATE KEY-----\n";

function makePort(behavior: { failCommands?: RegExp } = {}) {
  return createSshDeployPort(
    { adminKey: async () => ADMIN_KEY },
    { deps: baseDeps(behavior) },
  );
}

const DEPLOY_INPUT = {
  hostId: "h1",
  address: HOST_A,
  targetUser: USER_A,
  fingerprint: FINGERPRINT,
  publicKey: PUBLIC_KEY,
  secretId: SECRET_ID,
};

beforeEach(() => {
  filesByHost.clear();
  createdKeyFiles.length = 0;
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("myrmidon(SEC1-C) ssh-ops: pure body transforms", () => {
  it("deploy adds the marker line to an existing file and keeps foreign lines", () => {
    const body = "ssh-ed25519 AAAAFOREIGNKEY1 operator@laptop\n";
    const plan = applyDeployToBody(body, {
      secretId: SECRET_ID,
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    expect(plan.already).toBe(false);
    expect(plan.next).toContain(`myrmidon-access-${SECRET_ID}`);
    expect(plan.next).toContain(FINGERPRINT);
    expect(plan.next).toContain("AAAAFOREIGNKEY1");
  });

  it("a repeated deploy of the same key is idempotent (no change)", () => {
    const first = applyDeployToBody("", {
      secretId: SECRET_ID,
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    expect(first.next).not.toBeNull();
    const second = applyDeployToBody(first.next as string, {
      secretId: SECRET_ID,
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    expect(second.already).toBe(true);
    expect(second.next).toBeNull();
  });

  it("a drifted marker line (rotated key) is replaced, not duplicated", () => {
    const rotatedKey = PUBLIC_KEY.split("EXAMPLE").join("ROTATED");
    const first = applyDeployToBody("", {
      secretId: SECRET_ID,
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    const second = applyDeployToBody(first.next as string, {
      secretId: SECRET_ID,
      publicKey: rotatedKey,
      fingerprint: "SHA256:new",
    });
    expect(second.already).toBe(false);
    expect(second.next).toContain("ROTATED");
    expect(second.next).not.toContain("EXAMPLEBODY");
    expect(second.next?.split("\n").filter((l) => l.includes("myrmidon-access-"))).toHaveLength(1);
  });

  it("revoke removes the marker line and keeps foreign lines", () => {
    const body = `ssh-ed25519 AAAAFOREIGNKEY1 operator@laptop
ssh-ed25519 AAAAMARKED myrmidon-access-${SECRET_ID} ${FINGERPRINT}
`;
    const plan = applyRevokeFromBody(body, SECRET_ID);
    expect(plan.next).not.toContain("myrmidon-access-");
    expect(plan.next).toContain("AAAAFOREIGNKEY1");
  });

  it("revoke of an absent marker changes nothing", () => {
    const body = "ssh-ed25519 AAAAFOREIGNKEY1 operator@laptop\n";
    expect(applyRevokeFromBody(body, SECRET_ID).next).toBeNull();
  });

  it("the marker must be a standalone word: a foreign comment mentioning it is not ours", () => {
    const body = "ssh-ed25519 AAAAFOREIGNKEY1 myrmidon-access-other-secret-2 x\n";
    const plan = applyRevokeFromBody(body, SECRET_ID);
    expect(plan.next).toBeNull();
  });

  it("deploy on an unparseable public key still produces one line", () => {
    const plan = applyDeployToBody("", {
      secretId: SECRET_ID,
      publicKey: "garbage",
      fingerprint: FINGERPRINT,
    });
    expect(plan.next).toContain("myrmidon-access-");
  });
});

describe("myrmidon(SEC1-C) ssh-ops: settings", () => {
  it("defaults the timeout and honors the env override", () => {
    expect(readSshOpsSettings({}).commandTimeoutMs).toBe(DEFAULT_SSH_COMMAND_TIMEOUT_MS);
    expect(readSshOpsSettings({ MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS: "5000" }).commandTimeoutMs).toBe(5000);
    expect(readSshOpsSettings({ MYRMIDON_ACCESS_HUB_SSH_TIMEOUT_MS: "nope" }).commandTimeoutMs).toBe(
      DEFAULT_SSH_COMMAND_TIMEOUT_MS,
    );
  });
});

describe("myrmidon(SEC1-C) ssh-ops: deploy/revoke through the fake ssh", () => {
  it("deploys into the fake authorized_keys and the second call is already_present", async () => {
    const port = makePort();
    const first = await port.deploy(DEPLOY_INPUT);
    expect(first.outcome).toBe("deployed");
    expect(fileOf(`${USER_A}@${HOST_A}`)).toContain(`myrmidon-access-${SECRET_ID}`);
    const second = await port.deploy(DEPLOY_INPUT);
    expect(second.outcome).toBe("already_present");
  });

  it("revoke removes the line and a second revoke says not_deployed", async () => {
    const port = makePort();
    await port.deploy(DEPLOY_INPUT);
    const revoked = await port.revoke(DEPLOY_INPUT);
    expect(revoked.outcome).toBe("deployed");
    expect(fileOf(`${USER_A}@${HOST_A}`)).not.toContain("myrmidon-access-");
    const again = await port.revoke(DEPLOY_INPUT);
    expect(again.outcome).toBe("not_deployed");
  });

  it("dryRun reports what would happen without writing", async () => {
    const port = makePort();
    const dry = await port.dryRun(DEPLOY_INPUT);
    expect(dry.outcome).toBe("dry_run");
    expect(fileOf(`${USER_A}@${HOST_A}`)).toBe("");
    await port.deploy(DEPLOY_INPUT);
    const dryAfter = await port.dryRun(DEPLOY_INPUT);
    expect(dryAfter.outcome).toBe("already_present");
  });

  it("a failed ssh leaves the key file deleted (finally) and reports a timeout note", async () => {
    const port = makePort({ failCommands: /^cat / });
    const result = await port.deploy(DEPLOY_INPUT);
    expect(result.outcome).toBe("not_deployed");
    expect(result.note).toContain("timed out");
    // The key file from the failed run is already gone (finally ran before
    // the promise resolved), and the scratch root has no leftovers.
    expect(createdKeyFiles.every((p) => !existsSync(p))).toBe(true);
  });

  it("the key file holds exactly the admin key during the run (0600 lifecycle)", async () => {
    const port = createSshDeployPort(
      { adminKey: async () => ADMIN_KEY },
      {
        deps: {
          execFile: fakeExecFile({ keyMaterial: ADMIN_KEY }) as never,
          scratchDir: () => scratchRoot,
          mkdtemp: async (prefix: string) => {
            const dir = `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
            mkdirSync(dir, { recursive: true });
            return dir;
          },
        },
      },
    );
    await port.deploy(DEPLOY_INPUT);
    expect(createdKeyFiles.length).toBeGreaterThan(0);
  });

  it("no admin key configured: not_deployed with a human note", async () => {
    const port = createSshDeployPort({ adminKey: async () => null }, { deps: baseDeps() });
    const result = await port.deploy(DEPLOY_INPUT);
    expect(result.outcome).toBe("not_deployed");
    expect(result.note).toContain("admin ssh key");
  });

  it("invalid target input is rejected before any ssh runs", async () => {
    const port = makePort();
    const bad = await port.deploy({ ...DEPLOY_INPUT, targetUser: "bad user!" });
    expect(bad.outcome).toBe("not_deployed");
    expect(bad.note).toContain("target user");
    expect(createdKeyFiles).toHaveLength(0);
  });

  it("notes never contain the host address, the user or key material", async () => {
    const port = makePort();
    const results = [await port.deploy(DEPLOY_INPUT), await port.revoke(DEPLOY_INPUT)];
    for (const result of results) {
      expect(result.note).not.toContain(HOST_A);
      expect(result.note).not.toContain(USER_A);
      expect(result.note).not.toContain("PRIVATE KEY");
    }
  });

  it("an oversized read body is refused, not echoed back", async () => {
    const big = "x".repeat(300 * 1024);
    const port = createSshDeployPort(
      { adminKey: async () => ADMIN_KEY },
      {
        deps: {
          execFile: (async (_f: string, args: string[]) => {
            const target = String(args[args.length - 2]);
            const command = String(args[args.length - 1]);
            if (command.startsWith("cat ")) return { stdout: big };
            throw new Error(`unexpected write: ${command.slice(0, 40)}`);
          }) as never,
          scratchDir: () => scratchRoot,
          mkdtemp: async (prefix: string) => {
            const dir = `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
            mkdirSync(dir, { recursive: true });
            return dir;
          },
        },
      },
    );
    const result = await port.deploy(DEPLOY_INPUT);
    expect(result.outcome).toBe("not_deployed");
    expect(result.note).toContain("too large");
  });
});
