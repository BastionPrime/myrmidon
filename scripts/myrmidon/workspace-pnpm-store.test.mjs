// Shared pnpm store for execution worktrees (myrmidon, WORKSPACE-HYGIENE).
//
// The vendored provision-worktree.sh runs `pnpm install` with pnpm's default
// store placement, so every execution worktree of the same repository imports
// a full private copy of every package (gigabytes per branch; disk-full
// incident on 2026-09-30). The marked block in provision-worktree.sh resolves
// a store outside the worktree and adds --store-dir plus
// --config.package-import-method=hardlink to the install.
//
// These tests run the real script against a fake `pnpm` that records its argv
// (the same approach as the vendored vitest fixtures): no network, no real
// package downloads. Node built-ins only; node --test runs this file as part
// of the scripts/myrmidon CI step.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

const scriptPath = new URL("../provision-worktree.sh", import.meta.url);
const scriptPathFile = fileURLToPath(scriptPath);
const scriptIsExecutable = (fs.statSync(scriptPathFile).mode & 0o111) !== 0;
const runScriptFile = scriptIsExecutable ? scriptPathFile : "bash";
const runScriptArgs = scriptIsExecutable ? [] : [scriptPathFile];

async function writeRegisteredSourceConfig(baseRoot, instanceId = "source-instance") {
  const configDir = path.join(baseRoot, ".paperclip");
  await fs.promises.mkdir(configDir, { recursive: true });
  await fs.promises.writeFile(path.join(configDir, "config.json"), "{}\n", "utf8");
  await fs.promises.writeFile(
    path.join(configDir, ".env"),
    `PAPERCLIP_INSTANCE_ID=${instanceId}\n`,
    "utf8",
  );
}

// Writes the isolated worktree config + env pair that makes the script take
// its "reuse existing worktree config" path, the same shape the vendored
// fixtures use, so provisioning proceeds straight to the install step. The
// instance id must match the path-derived id the script computes on its own.
async function writeUsableWorktreeConfig(worktreeRoot) {
  const paperclipDir = path.join(worktreeRoot, ".paperclip");
  await fs.promises.mkdir(paperclipDir, { recursive: true });
  const worktreeHome = path.join(path.dirname(worktreeRoot), "worktree-home");
  const instanceId = await computeWorktreeInstanceId(worktreeRoot);
  await fs.promises.mkdir(path.join(worktreeHome, "instances", instanceId), { recursive: true });
  await fs.promises.writeFile(
    path.join(paperclipDir, "config.json"),
    JSON.stringify({ server: { deploymentMode: "local_trusted", exposure: "private" } }, null, 2),
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(paperclipDir, ".env"),
    [
      `PAPERCLIP_HOME=${worktreeHome}`,
      `PAPERCLIP_INSTANCE_ID=${instanceId}`,
      `PAPERCLIP_CONFIG=${paperclipDir}/config.json`,
      "",
    ].join("\n"),
    "utf8",
  );
}

// Mirrors the basename + sha256(worktree path) id provision-worktree.sh
// derives for the isolated instance.
async function computeWorktreeInstanceId(worktreeRoot) {
  const { createHash } = await import("node:crypto");
  const resolved = path.resolve(worktreeRoot);
  const normalized = path.basename(resolved)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const prefix = (normalized || "worktree").slice(0, 48);
  const pathHash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

// The fake pnpm accepts every `install --prod=false ...` call, creates a
// node_modules marker so the next provision run skips the install (matching
// the real fingerprint logic), and records the full argv plus the caller's
// working directory, one pair per line.
async function writeFakePnpm(fakeBin, callsLogPath) {
  await fs.promises.mkdir(fakeBin, { recursive: true });
  const fakePnpmPath = path.join(fakeBin, "pnpm");
  await fs.promises.writeFile(
    fakePnpmPath,
    [
      "#!/bin/sh",
      `calls=${JSON.stringify(callsLogPath)}`,
      `printf '%s\\n' "pnpm $*" >> "$calls"`,
      `printf '%s\\n' "$PWD" >> "$calls"`,
      'if [ "$1" = "install" ]; then',
      '  mkdir -p "$PWD/node_modules"',
      '  : > "$PWD/node_modules/.installed"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.promises.chmod(fakePnpmPath, 0o755);
}

async function makeWorktreeFixture(parent, name) {
  const worktreeRoot = path.join(parent, `${name}-worktree`);
  await fs.promises.mkdir(path.join(worktreeRoot, "node_modules"), { recursive: true });
  await fs.promises.writeFile(
    path.join(worktreeRoot, "package.json"),
    JSON.stringify({ name: "workspace-root", private: true, packageManager: "pnpm@9.15.4" }, null, 2),
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(worktreeRoot, "pnpm-lock.yaml"),
    ["lockfileVersion: '9.0'", "", "importers:", "  .: {}", ""].join("\n"),
    "utf8",
  );
  await writeUsableWorktreeConfig(worktreeRoot);
  return worktreeRoot;
}

function readCalls(callsLogPath) {
  const lines = fs.readFileSync(callsLogPath, "utf8").split("\n").filter((line) => line.length > 0);
  const calls = [];
  for (let index = 0; index < lines.length; index += 2) {
    calls.push({ argv: lines[index], cwd: lines[index + 1] });
  }
  return calls;
}

describe("provision-worktree shared pnpm store (WORKSPACE-HYGIENE)", () => {
  it("installs with the shared store flags and creates the store outside the worktree", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myrmidon-pnpm-store-"));
    try {
      const baseRoot = path.join(tempRoot, "base");
      const worktreeRoot = await makeWorktreeFixture(tempRoot, "alpha");
      const fakeBin = path.join(tempRoot, "bin");
      const callsLogPath = path.join(tempRoot, "calls.log");
      await writeRegisteredSourceConfig(baseRoot);
      await writeFakePnpm(fakeBin, callsLogPath);

      const expectedStoreDir = path.join(baseRoot, ".paperclip", "pnpm-store");

      const result = await execFileAsync(runScriptFile, runScriptArgs, {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
        },
      });

      assert.equal(fs.existsSync(path.join(worktreeRoot, "node_modules", ".installed")), true);
      const calls = readCalls(callsLogPath);
      assert.equal(calls.length, 1);
      const installCall = calls[0];
      assert.match(installCall.argv, /^pnpm install --prod=false --frozen-lockfile/);
      assert.ok(
        installCall.argv.includes(`--store-dir=${expectedStoreDir}`),
        `install argv must pin the shared store: ${installCall.argv}`,
      );
      assert.ok(
        installCall.argv.includes("--config.package-import-method=hardlink"),
        `install argv must force hardlink imports: ${installCall.argv}`,
      );
      // The store lives outside the worktree, anchored at the base workspace
      // root (same volume in the standard layout).
      assert.ok(result.stderr.includes(`Execution workspace pnpm install uses shared store: ${expectedStoreDir}`));
      assert.equal(fs.existsSync(expectedStoreDir), true);
      assert.equal(fs.statSync(expectedStoreDir).isDirectory(), true);
      const relative = path.relative(worktreeRoot, expectedStoreDir);
      assert.ok(relative.startsWith(".."), "store must live outside the worktree");
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reuses the same shared store for a second worktree of the same repository", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myrmidon-pnpm-store-2-"));
    try {
      const baseRoot = path.join(tempRoot, "base");
      const firstWorktree = await makeWorktreeFixture(tempRoot, "first");
      const secondWorktree = await makeWorktreeFixture(tempRoot, "second");
      const fakeBin = path.join(tempRoot, "bin");
      const callsLogPath = path.join(tempRoot, "calls.log");
      await writeRegisteredSourceConfig(baseRoot);
      await writeFakePnpm(fakeBin, callsLogPath);

      const expectedStoreDir = path.join(baseRoot, ".paperclip", "pnpm-store");
      const runWithFakePnpm = (worktreeRoot) => execFileAsync(runScriptFile, runScriptArgs, {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
        },
      });

      await runWithFakePnpm(firstWorktree);
      await runWithFakePnpm(secondWorktree);

      const calls = readCalls(callsLogPath);
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.ok(
          call.argv.includes(`--store-dir=${expectedStoreDir}`),
          `both installs must use the shared store: ${call.argv}`,
        );
        assert.ok(call.argv.includes("--config.package-import-method=hardlink"));
      }
      assert.notEqual(calls[0].cwd, calls[1].cwd);
      // The second install worked against a store that already existed after
      // the first one (accepts existing store); both worktrees installed.
      assert.equal(fs.existsSync(expectedStoreDir), true);
      assert.equal(fs.existsSync(path.join(firstWorktree, "node_modules", ".installed")), true);
      assert.equal(fs.existsSync(path.join(secondWorktree, "node_modules", ".installed")), true);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the vendor install argv when the shared store is disabled", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myrmidon-pnpm-store-3-"));
    try {
      const baseRoot = path.join(tempRoot, "base");
      const worktreeRoot = await makeWorktreeFixture(tempRoot, "off");
      const fakeBin = path.join(tempRoot, "bin");
      const callsLogPath = path.join(tempRoot, "calls.log");
      await writeRegisteredSourceConfig(baseRoot);
      await writeFakePnpm(fakeBin, callsLogPath);

      await execFileAsync(runScriptFile, runScriptArgs, {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
          MYRMIDON_WORKSPACE_PNPM_STORE: "0",
        },
      });

      const calls = readCalls(callsLogPath);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].argv, "pnpm install --prod=false --frozen-lockfile");
      assert.equal(fs.existsSync(path.join(baseRoot, ".paperclip", "pnpm-store")), false);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("honors an absolute MYRMIDON_WORKSPACE_PNPM_STORE_DIR override", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myrmidon-pnpm-store-4-"));
    try {
      const baseRoot = path.join(tempRoot, "base");
      const worktreeRoot = await makeWorktreeFixture(tempRoot, "custom");
      const fakeBin = path.join(tempRoot, "bin");
      const callsLogPath = path.join(tempRoot, "calls.log");
      await writeRegisteredSourceConfig(baseRoot);
      await writeFakePnpm(fakeBin, callsLogPath);

      const customStore = path.join(tempRoot, "custom-store");

      await execFileAsync(runScriptFile, runScriptArgs, {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
          MYRMIDON_WORKSPACE_PNPM_STORE_DIR: customStore,
        },
      });

      const calls = readCalls(callsLogPath);
      assert.equal(calls.length, 1);
      assert.ok(
        calls[0].argv.includes(`--store-dir=${customStore}`),
        `install argv must use the configured store: ${calls[0].argv}`,
      );
      assert.equal(fs.existsSync(customStore), true);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the vendor behavior when the store path is on another filesystem", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "myrmidon-pnpm-store-5-"));
    try {
      const baseRoot = path.join(tempRoot, "base");
      const worktreeRoot = await makeWorktreeFixture(tempRoot, "crossfs");
      const fakeBin = path.join(tempRoot, "bin");
      const callsLogPath = path.join(tempRoot, "calls.log");
      await writeRegisteredSourceConfig(baseRoot);
      await writeFakePnpm(fakeBin, callsLogPath);

      // /dev/shm is a tmpfs on every mainstream Linux; on a host without it
      // (or where it shares the device with the worktree) this test returns
      // early instead of failing on environment shape.
      const otherDeviceRoot = "/dev/shm";
      const storeThere = path.join(otherDeviceRoot, `myrmidon-store-${process.pid}`);
      if (fs.statSync(otherDeviceRoot).dev === fs.statSync(worktreeRoot).dev) {
        return;
      }

      const result = await execFileAsync(runScriptFile, runScriptArgs, {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
          MYRMIDON_WORKSPACE_PNPM_STORE_DIR: storeThere,
        },
      });

      assert.ok(result.stderr.includes("different filesystem"));
      const calls = readCalls(callsLogPath);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].argv, "pnpm install --prod=false --frozen-lockfile");
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
