import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

describe("docker/bot-runtime/entrypoint.sh", () => {
  it("fails when API_SERVER_KEY is unset", () => {
    const result = run({});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_SERVER_KEY/);
  });

  it("fails when API_SERVER_KEY is empty", () => {
    const result = run({ API_SERVER_KEY: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_SERVER_KEY/);
  });

  it("fails when API_SERVER_KEY is shorter than hermes' own 16-char floor", () => {
    const result = run({ API_SERVER_KEY: "short" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16/);
  });

  it("fails when HERMES_HOME is unset", () => {
    const result = run({ API_SERVER_KEY: "a".repeat(32) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HERMES_HOME/);
  });

  it("gets past both env checks with a valid key and HERMES_HOME (then fails only because hermes is not installed here)", () => {
    const result = run({
      API_SERVER_KEY: "a".repeat(32),
      HERMES_HOME: "/tmp/myrmidon-bot-runtime-test-hermes-home",
    });
    // hermes is not on PATH in this test environment — the script must have
    // gotten past its own validation (which logs "FATAL: ..." and exits
    // before the final `exec`) to fail this way instead.
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
  });
});
