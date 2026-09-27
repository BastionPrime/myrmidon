import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_CONFLICT, EXIT_OK, runVendorSync } from "./vendor-sync.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor-sync.mjs");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Bot",
  GIT_AUTHOR_EMAIL: "bot@example.com",
  GIT_COMMITTER_NAME: "Test Bot",
  GIT_COMMITTER_EMAIL: "bot@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
};

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(repo, file, content) {
  const full = path.join(repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commit(repo, message, files) {
  for (const [file, content] of Object.entries(files)) write(repo, file, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

const DIVERGENCE = `# Registry

## Track 2

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| P1 | release leases | \`server/src/services/heartbeat.ts\` | leases leak | \`heartbeat.myrmidon.test.ts\` | never, our behaviour | #1 |
| vendor:abc1234 | chat fix | \`server/src/routes/chat.ts\` | vendor #13654 | vendor tests | when the vendor tag contains #13654 | #2 |
`;

/**
 * Fake vendor with a stable tag v2026.901.0, and a fork cloned from it with
 * our registry and a marked edit in heartbeat.ts.
 */
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vendor-sync-test-"));
  roots.push(root);
  const vendor = path.join(root, "vendor");
  const fork = path.join(root, "fork");
  mkdirSync(vendor);
  git(vendor, "init", "-q", "-b", "master");
  commit(vendor, "chore: initial", {
    "server/src/services/heartbeat.ts": "export const a = 1;\nexport const b = 2;\n",
    "server/src/routes/chat.ts": "export const chat = 1;\n",
    "package.json": '{ "name": "vendor" }\n',
  });
  git(vendor, "tag", "-a", "v2026.901.0", "-m", "v2026.901.0");

  git(root, "clone", "-q", vendor, fork);
  git(fork, "checkout", "-q", "-b", "main");
  git(fork, "tag", "-l"); // clone brought v2026.901.0
  commit(fork, "docs: registry", {
    "docs/myrmidon/DIVERGENCE.md": DIVERGENCE,
    "server/src/services/heartbeat.ts":
      "export const a = 1;\n// myrmidon(P1): release leases\nexport const b = 2;\n",
  });
  return { root, vendor, fork };
}

function sync(fork, vendor, extra = {}) {
  const logs = [];
  const result = runVendorSync(
    { repo: fork, vendor, base: "main", tag: null, report: null, fetch: true, ...extra },
    (line) => logs.push(line),
  );
  return { ...result, logs };
}

function withEnv(fn) {
  const saved = {};
  for (const key of Object.keys(GIT_ENV)) {
    if (key.startsWith("GIT_")) {
      saved[key] = process.env[key];
      process.env[key] = GIT_ENV[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("vendor-sync", () => {
  let env;
  beforeEach(() => {
    env = setup();
  });

  it("does nothing when there is no new stable tag", () =>
    withEnv(() => {
      const before = git(env.fork, "rev-parse", "HEAD");
      const result = sync(env.fork, env.vendor);
      assert.equal(result.code, EXIT_OK);
      assert.equal(result.outcome, "nothing");
      assert.equal(result.base, "v2026.901.0");
      assert.equal(git(env.fork, "rev-parse", "HEAD"), before);
      assert.equal(git(env.fork, "branch", "--list", "sync/*"), "");
      assert.equal(result.reportPath, null);
      assert.equal(existsSync(path.join(env.fork, ".git", "sync-report.md")), false);
    }));

  it("ignores canary, beta, rc and nightly tags", () =>
    withEnv(() => {
      commit(env.vendor, "feat: canary work (#200)", { "server/src/new.ts": "export {};\n" });
      git(env.vendor, "tag", "v2026.908.0-canary.1");
      git(env.vendor, "tag", "v2026.908.0-beta.1");
      git(env.vendor, "tag", "v2026.908.0-rc.1");
      git(env.vendor, "tag", "canary/v2026.908.0-canary.2");
      git(env.vendor, "tag", "nightly/v2026.908.0-nightly.0");
      const result = sync(env.fork, env.vendor);
      assert.equal(result.outcome, "nothing");
      assert.equal(result.code, EXIT_OK);
      assert.equal(git(env.fork, "branch", "--list", "sync/*"), "");
    }));

  it("creates sync/<tag> with a merge commit for a new stable tag", () =>
    withEnv(() => {
      commit(env.vendor, "fix(chat): synthetic id (#13654)", { "server/src/routes/chat.ts": "export const chat = 2;\n" });
      git(env.vendor, "tag", "-a", "v2026.908.0", "-m", "v2026.908.0");
      commit(env.vendor, "feat: later canary", { "server/src/later.ts": "export {};\n" });
      git(env.vendor, "tag", "v2026.915.0-canary.0");

      const result = sync(env.fork, env.vendor);
      assert.equal(result.code, EXIT_OK);
      assert.equal(result.outcome, "merged");
      assert.equal(result.tag, "v2026.908.0");
      assert.equal(git(env.fork, "rev-parse", "--abbrev-ref", "HEAD"), "sync/v2026.908.0");
      // A real merge commit: two parents, the second is the vendor tag.
      const parents = git(env.fork, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
      assert.equal(parents.length, 3);
      assert.equal(parents[2], git(env.fork, "rev-parse", "v2026.908.0^{commit}"));
      assert.equal(git(env.fork, "log", "-1", "--format=%s"), "Merge vendor release v2026.908.0");
      assert.equal(readFileSync(path.join(env.fork, "server/src/routes/chat.ts"), "utf8"), "export const chat = 2;\n");
      // main itself is untouched.
      assert.notEqual(git(env.fork, "rev-parse", "main"), git(env.fork, "rev-parse", "HEAD"));

      assert.equal(result.reportPath, path.join(env.fork, ".git", "sync-report.md"));
      const report = readFileSync(result.reportPath, "utf8");
      assert.match(report, /Outcome: \*\*merged\*\*/);
      assert.match(report, /Base: `v2026\.901\.0`/);
      assert.match(report, /fix\(chat\): synthetic id \(#13654\)/);
      assert.match(report, /\*\*vendor:abc1234\*\* \(Track 2\): vendor #13654 is in the range/);
      assert.doesNotMatch(report, /\*\*P1\*\*/);
      assert.doesNotMatch(report, /later canary/);
    }));

  it("picks the highest stable tag across month boundaries", () =>
    withEnv(() => {
      commit(env.vendor, "fix: one", { "a.txt": "1\n" });
      git(env.vendor, "tag", "v2026.930.0");
      commit(env.vendor, "fix: two", { "a.txt": "2\n" });
      git(env.vendor, "tag", "v2026.1007.0");
      commit(env.vendor, "fix: three", { "a.txt": "3\n" });
      git(env.vendor, "tag", "v2026.1007.1");
      const result = sync(env.fork, env.vendor);
      assert.equal(result.tag, "v2026.1007.1");
      assert.equal(result.outcome, "merged");
    }));

  it("reports conflicts with exit code 2 and aborts the merge", () =>
    withEnv(() => {
      commit(env.vendor, "refactor(heartbeat): rework (#300)", {
        "server/src/services/heartbeat.ts": "export const a = 10;\nexport const b = 20;\n",
      });
      git(env.vendor, "tag", "v2026.908.0");

      const result = sync(env.fork, env.vendor);
      assert.equal(result.code, EXIT_CONFLICT);
      assert.equal(result.outcome, "conflict");
      assert.deepEqual(result.conflicts, ["server/src/services/heartbeat.ts"]);
      // Merge aborted: clean tree, branch left at main.
      assert.equal(git(env.fork, "status", "--porcelain", "--untracked-files=no"), "");
      assert.equal(git(env.fork, "rev-parse", "HEAD"), git(env.fork, "rev-parse", "main"));
      assert.equal(git(env.fork, "rev-parse", "--abbrev-ref", "HEAD"), "sync/v2026.908.0");

      const report = readFileSync(result.reportPath, "utf8");
      assert.match(report, /Outcome: \*\*conflict\*\*/);
      assert.match(report, /## Conflicts[\s\S]*- `server\/src\/services\/heartbeat\.ts`/);
      assert.match(report, /`server\/src\/services\/heartbeat\.ts`: Track 2 — \| P1 \|/);
    }));

  it("lists marked files, new workflows, migrations and dependency files", () =>
    withEnv(() => {
      commit(env.vendor, "chore: many things (#400)", {
        "server/src/services/heartbeat.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
        ".github/workflows/new-release.yml": "name: release\n",
        "packages/db/src/migrations/0300_new_table.sql": "select 1;\n",
        "package.json": '{ "name": "vendor", "version": "2" }\n',
        "Dockerfile": "FROM node:24\n",
      });
      git(env.vendor, "tag", "v2026.908.0");

      const result = sync(env.fork, env.vendor);
      assert.equal(result.outcome, "merged");
      const report = readFileSync(result.reportPath, "utf8");
      const section = (title) => report.split(`## ${title}`)[1].split("\n## ")[0];
      assert.match(section("Vendor changes in files with our `myrmidon(` markers"), /server\/src\/services\/heartbeat\.ts` — changed/);
      assert.match(section("Workflows (.github/workflows)"), /new-release\.yml` — new/);
      assert.match(section("New database migrations"), /0300_new_table\.sql` — new/);
      const deps = section("Dependencies and image (package.json, pnpm-lock.yaml, Dockerfile)");
      assert.match(deps, /`package\.json` — changed/);
      assert.match(deps, /`Dockerfile` — new/);
      // Our marked edit survived the merge.
      assert.match(readFileSync(path.join(env.fork, "server/src/services/heartbeat.ts"), "utf8"), /myrmidon\(P1\)/);
    }));

  it("refuses to reuse an existing sync branch and a dirty tree", () =>
    withEnv(() => {
      commit(env.vendor, "fix: x", { "x.txt": "x\n" });
      git(env.vendor, "tag", "v2026.908.0");
      git(env.fork, "branch", "sync/v2026.908.0");
      assert.throws(() => sync(env.fork, env.vendor), /already exists/);
      git(env.fork, "branch", "-D", "sync/v2026.908.0");
      write(env.fork, "server/src/routes/chat.ts", "dirty\n");
      assert.throws(() => sync(env.fork, env.vendor), /uncommitted changes/);
    }));

  it("CLI exits 0 when there is nothing to do and 2 on conflict", () =>
    withEnv(() => {
      const run = () => {
        try {
          execFileSync(process.execPath, [SCRIPT, "--repo", env.fork, "--vendor", env.vendor], {
            env: GIT_ENV,
            stdio: ["ignore", "pipe", "pipe"],
          });
          return 0;
        } catch (error) {
          return error.status;
        }
      };
      assert.equal(run(), 0);
      commit(env.vendor, "refactor(heartbeat): rework", {
        "server/src/services/heartbeat.ts": "export const a = 10;\nexport const b = 20;\n",
      });
      git(env.vendor, "tag", "v2026.908.0");
      assert.equal(run(), 2);
    }));
});
