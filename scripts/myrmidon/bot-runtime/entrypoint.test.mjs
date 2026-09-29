import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// docker/bot-runtime/entrypoint.sh fails fast (before ever reaching `exec
// hermes`, which is not installed in this test environment) when required
// environment is missing or unusable. We only exercise the failure paths:
// the success path execs a real hermes binary this sandbox does not have.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRYPOINT = path.join(ROOT, "docker/bot-runtime/entrypoint.sh");

function run(env) {
  return spawnSync("bash", [ENTRYPOINT], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

/** A fresh HERMES_HOME dir, optionally with a .env carrying API_SERVER_KEY. */
function hermesHome(envLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-bot-runtime-test-"));
  if (envLine !== undefined) {
    fs.writeFileSync(path.join(dir, ".env"), envLine, "utf8");
  }
  return dir;
}

describe("docker/bot-runtime/entrypoint.sh", () => {
  it("fails when HERMES_HOME is unset, before even looking at API_SERVER_KEY", () => {
    const result = run({});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HERMES_HOME/);
  });

  it("fails when API_SERVER_KEY is not set anywhere (not in env, no ${HERMES_HOME}/.env)", () => {
    const dir = hermesHome();
    const result = run({ HERMES_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_SERVER_KEY/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when ${HERMES_HOME}/.env exists but has no API_SERVER_KEY line", () => {
    const dir = hermesHome("SOME_OTHER_VAR=1\n");
    const result = run({ HERMES_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_SERVER_KEY/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the key from ${HERMES_HOME}/.env is shorter than hermes' own 16-char floor", () => {
    const dir = hermesHome('API_SERVER_KEY="short"\n');
    const result = run({ HERMES_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when a directly-set API_SERVER_KEY is shorter than hermes' own 16-char floor", () => {
    const dir = hermesHome();
    const result = run({ HERMES_HOME: dir, API_SERVER_KEY: "short" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gets past both checks with a valid key read from ${HERMES_HOME}/.env alone (the bot-runtime contract path — no API_SERVER_KEY in the container's own env)", () => {
    const dir = hermesHome(`API_SERVER_KEY="${"a".repeat(32)}"\n`);
    const result = run({ HERMES_HOME: dir });
    // hermes is not on PATH in this test environment — the script must have
    // gotten past its own validation (which logs "FATAL: ..." and exits
    // before the final `exec`) to fail this way instead.
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a .env value with single quotes or no quotes at all, not just double quotes", () => {
    for (const line of [`API_SERVER_KEY='${"b".repeat(32)}'\n`, `API_SERVER_KEY=${"b".repeat(32)}\n`]) {
      const dir = hermesHome(line);
      const result = run({ HERMES_HOME: dir });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /FATAL/);
      assert.match(result.stderr, /hermes/i);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gets past both checks with a valid key set directly in the environment (manual/local run, not the fleet driver)", () => {
    const dir = hermesHome();
    const result = run({
      API_SERVER_KEY: "a".repeat(32),
      HERMES_HOME: dir,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a key already in the environment over ${HERMES_HOME}/.env, without touching the file", () => {
    const dir = hermesHome('API_SERVER_KEY="short"\n'); // would fail the length check if read
    const result = run({ HERMES_HOME: dir, API_SERVER_KEY: "c".repeat(32) });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
