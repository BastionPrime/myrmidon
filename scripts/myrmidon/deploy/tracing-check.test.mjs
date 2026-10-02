import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// TRACING-HEALTH: tests of tracing-check.sh and of its hook in deploy.sh.
// Same harness pattern as deploy.test.mjs: the real scripts run against fake
// `docker`, `curl` and `git` first in PATH and answer from files in a sandbox;
// no test touches a real gateway, registry or remote.
//
// The red fixture is the incident: the legacy `langfuse` callback is effective
// (the gateway database only adds callbacks, so the config file can look clean)
// while the Langfuse server is v4, and nothing used to check tracing. Without
// the guard that install passes silently; with it the install is refused.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";
const LANGFUSE_URL = "http://langfuse.local";

// The only callback the bundle installs; every fixture below is written
// against it.
const OTLP = "langfuse_otel";
const LEGACY = "langfuse";

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bashPath() {
  return process.env.PATH.split(":")
    .map((d) => path.join(d, "bash"))
    .find((f) => fs.existsSync(f));
}

function baseEnv(sandbox) {
  return {
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    SANDBOX: sandbox.dir,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
  };
}

function runScript(sandbox, script, args) {
  const result = spawnSync(bashPath(), [path.join(HERE, script), ...args], {
    env: baseEnv(sandbox),
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// --- tracing-check.sh sandbox ------------------------------------------------
// A fake `curl` answers the Langfuse public health route (the credential-free
// v4 marker) from a file, and fails when the sandbox asks it to.
function checkSandbox({
  langfuseHealth = { status: "OK", version: "4.2.1" },
  probeFails = false,
  effectiveCallbacks,
  gatewayConfig,
  intendedFile,
} = {}) {
  const dir = tmpdir("myrmidon-tracing-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *api/public/health*)
    if [ -e "$SANDBOX/probe-fails" ]; then exit 7; fi
    cat "$SANDBOX/langfuse-health.json" ;;
  *) exit 7 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "langfuse-health.json"), JSON.stringify(langfuseHealth));
  if (probeFails) fs.writeFileSync(path.join(dir, "probe-fails"), "");
  if (effectiveCallbacks !== undefined) {
    fs.writeFileSync(
      path.join(dir, "effective-callbacks"),
      Array.isArray(effectiveCallbacks) ? `${effectiveCallbacks.join("\n")}\n` : effectiveCallbacks,
    );
  }
  if (gatewayConfig !== undefined) {
    fs.writeFileSync(path.join(dir, "gateway-config.yaml"), gatewayConfig);
  }
  if (intendedFile !== undefined) {
    fs.writeFileSync(path.join(dir, "intended.txt"), intendedFile);
  }
  return { dir, bin };
}

function check(sandbox, args = []) {
  return runScript(sandbox, "tracing-check.sh", args);
}

function commandFor(sandbox) {
  return `cat ${path.join(sandbox.dir, "effective-callbacks")}`;
}

function configFor(sandbox) {
  return path.join(sandbox.dir, "gateway-config.yaml");
}

function intendedFor(sandbox) {
  return path.join(sandbox.dir, "intended.txt");
}

describe("tracing-check.sh", () => {
  it("refuses the legacy callback on a v4 server (red fixture of the incident)", () => {
    const sb = checkSandbox({ effectiveCallbacks: [LEGACY, OTLP] });
    const { code, out } = check(sb, ["--langfuse-url", LANGFUSE_URL, "--callbacks-command", commandFor(sb)]);
    assert.notEqual(code, 0);
    assert.match(out, /legacy 'langfuse' callback/);
    assert.match(out, /the effective gateway callbacks/);
    assert.match(out, /langfuse_otel/);
    assert.match(out, /cannot be skipped/);
  });

  it("passes the OTLP-only callbacks on a v4 server (green fixture)", () => {
    const sb = checkSandbox({ effectiveCallbacks: [OTLP] });
    const { code, out } = check(sb, ["--langfuse-url", LANGFUSE_URL, "--callbacks-command", commandFor(sb)]);
    assert.equal(code, 0, out);
    assert.match(out, /callbacks ok \(OTLP only\)/);
  });

  it("reads the legacy callback out of the deployed gateway config (inline list)", () => {
    const sb = checkSandbox({ gatewayConfig: `litellm_settings:\n  callbacks: ["${OTLP}", "${LEGACY}"]\n` });
    const { code, out } = check(sb, ["--langfuse-url", LANGFUSE_URL, "--gateway-config", configFor(sb)]);
    assert.notEqual(code, 0);
    assert.match(out, /legacy 'langfuse' callback/);
  });

  it("reads the gateway config in the block form and passes a clean one", () => {
    const bad = checkSandbox({ gatewayConfig: `litellm_settings:\n  callbacks:\n    - ${LEGACY}\n    - ${OTLP}\n` });
    const badRun = check(bad, ["--langfuse-url", LANGFUSE_URL, "--gateway-config", configFor(bad)]);
    assert.notEqual(badRun.code, 0, badRun.out);
    assert.match(badRun.out, /legacy 'langfuse' callback/);

    const good = checkSandbox({ gatewayConfig: `litellm_settings:\n  callbacks:\n    - ${OTLP}\n` });
    const goodRun = check(good, ["--langfuse-url", LANGFUSE_URL, "--gateway-config", configFor(good)]);
    assert.equal(goodRun.code, 0, goodRun.out);
  });

  it("takes the union of the live command and the config file", () => {
    // The file looks clean and the live gateway still carries the legacy
    // callback: the database only adds callbacks, so one clean source is not
    // proof.
    const sb = checkSandbox({
      effectiveCallbacks: [LEGACY],
      gatewayConfig: `litellm_settings:\n  callbacks: ["${OTLP}"]\n`,
    });
    const { code, out } = check(sb, [
      "--langfuse-url", LANGFUSE_URL,
      "--callbacks-command", commandFor(sb),
      "--gateway-config", configFor(sb),
    ]);
    assert.notEqual(code, 0, out);
    assert.match(out, /legacy 'langfuse' callback/);
  });

  it("accepts the legacy callback on a v3 server (the refusal is about v4)", () => {
    const sb = checkSandbox({ langfuseHealth: { status: "OK", version: "3.9.0" }, effectiveCallbacks: [LEGACY] });
    const { code, out } = check(sb, ["--langfuse-url", LANGFUSE_URL, "--callbacks-command", commandFor(sb)]);
    assert.equal(code, 0, out);
    assert.match(out, /Langfuse 3 accepts it/);
  });

  it("refuses an unproven version with a legacy callback instead of installing silently", () => {
    const sb = checkSandbox({ langfuseHealth: {}, effectiveCallbacks: [LEGACY] });
    const { code, out } = check(sb, ["--langfuse-url", LANGFUSE_URL, "--callbacks-command", commandFor(sb)]);
    assert.notEqual(code, 0);
    assert.match(out, /version cannot be proven/);
  });

  it("uses the version pinned in the bundle when the health route cannot be read", () => {
    const sb = checkSandbox({ probeFails: true, effectiveCallbacks: [LEGACY] });
    const { code, out } = check(sb, [
      "--langfuse-url", LANGFUSE_URL,
      "--langfuse-version", "4.1.0",
      "--callbacks-command", commandFor(sb),
    ]);
    assert.notEqual(code, 0, out);
    assert.match(out, /pinned in the bundle is 4\.1\.0/);
    assert.match(out, /legacy 'langfuse' callback/);
  });

  it("refuses when tracing is configured but the effective callbacks cannot be read", () => {
    const sb = checkSandbox({});
    const { code, out } = check(sb, ["--langfuse-url", LANGFUSE_URL]);
    assert.notEqual(code, 0);
    assert.match(out, /the effective callback set cannot be read/);
  });

  it("skips the check when no tracing input is configured", () => {
    const sb = checkSandbox({});
    const { code, out } = check(sb, []);
    assert.equal(code, 0, out);
    assert.match(out, /the callback check is skipped/);
  });

  it("refuses the legacy callback in the intended list the bundle itself carries", () => {
    const sb = checkSandbox({ effectiveCallbacks: [OTLP], intendedFile: `${LEGACY}\n` });
    const { code, out } = check(sb, [
      "--langfuse-url", LANGFUSE_URL,
      "--gateway-config", configFor(sb),
      "--intended-file", intendedFor(sb),
    ]);
    assert.notEqual(code, 0);
    assert.match(out, /the callback list the bundle itself installs/);
  });

  it("has one source of truth for the callback list: the generated file matches the function", () => {
    const sb = checkSandbox({});
    const printed = check(sb, ["--print-intended"]);
    assert.equal(printed.code, 0, printed.out);
    assert.equal(printed.out.trim(), OTLP);

    const generated = path.join(sb.dir, "generated", "tracing-callbacks.txt");
    const written = check(sb, ["--write-intended", generated]);
    assert.equal(written.code, 0, written.out);
    assert.equal(fs.readFileSync(generated, "utf8"), `${OTLP}\n`);

    // The check reads the generated file, not a second hand-written list:
    // the same file with the legacy name in it is refused.
    fs.writeFileSync(generated, `${LEGACY}\n`);
    fs.writeFileSync(path.join(sb.dir, "effective-callbacks"), `${OTLP}\n`);
    const { code, out } = check(sb, [
      "--langfuse-url", LANGFUSE_URL,
      "--callbacks-command", commandFor(sb),
      "--intended-file", generated,
    ]);
    assert.notEqual(code, 0, out);
    assert.match(out, /the callback list the bundle itself installs/);
  });
});

// --- deploy.sh integration ---------------------------------------------------
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  pull) exit 0 ;;
  image)
    case "$*" in
      *org.opencontainers.image.version*) cat "$SANDBOX/label-version" ;;
      *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision" ;;
    esac ;;
  buildx)
    case "$4" in
      *myrmidon-dockergate*|*myrmidon-fleetd*)
        for a in "$@"; do case "$a" in *Manifest.Digest*) cat "$SANDBOX/component-digests.json" | jq -r --arg r "$4" '.[$r]'; exit 0 ;; esac; done
        cat "$SANDBOX/component-image.json" ;;
      *)
        if [ -e "$SANDBOX/registry-missing" ]; then echo "ERROR: $4: not found" >&2; exit 1; fi
        cat "$SANDBOX/imagetools.json" ;;
    esac ;;
  compose) exit 0 ;;
esac
`;

const FAKE_GIT = `#!/usr/bin/env bash
echo "git $*" >> "$SANDBOX/calls.log"
while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  rev-parse) echo "$SANDBOX/clone" ;;
  remote) cat "$SANDBOX/git-origin" ;;
  fetch) exit 0 ;;
  merge-base) exit 0 ;;
  ls-remote) cat "$SANDBOX/git-tags" ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *api/public/health*) if [ -e "$SANDBOX/probe-fails" ]; then exit 7; fi; cat "$SANDBOX/langfuse-health.json" ;;
  *) cat "$SANDBOX/health.json" ;;
esac
`;

function deploySandbox({ langfuseHealth = { status: "OK", version: "4.2.1" }, tracing } = {}) {
  const dir = tmpdir("myrmidon-deploy-tracing-");
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(
    path.join(dir, "imagetools.json"),
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Env: ["A=1"],
        Labels: {
          "org.opencontainers.image.revision": COMMIT,
          "org.opencontainers.image.source": SOURCE,
          "org.opencontainers.image.version": VERSION,
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "component-digests.json"),
    JSON.stringify({
      "ghcr.io/itkadr-git/myrmidon-dockergate:sha-0123456": `sha256:${"c".repeat(64)}`,
      "ghcr.io/itkadr-git/myrmidon-fleetd:sha-0123456": `sha256:${"d".repeat(64)}`,
    }),
  );
  fs.writeFileSync(
    path.join(dir, "component-image.json"),
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Env: ["A=1"],
        Labels: {
          "org.opencontainers.image.revision": COMMIT,
          "org.opencontainers.image.source": SOURCE,
          "org.opencontainers.image.version": VERSION,
        },
      },
      manifest: { digest: `sha256:${"c".repeat(64)}` },
    }),
  );
  fs.writeFileSync(path.join(dir, "git-origin"), `${ORIGIN}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), "");
  fs.writeFileSync(path.join(dir, "label-version"), `${VERSION}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${COMMIT}\n`);
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify({ status: "ok", version: VERSION, commit: COMMIT }));
  fs.writeFileSync(path.join(dir, "langfuse-health.json"), JSON.stringify(langfuseHealth));
  fs.writeFileSync(
    path.join(composeDir, "docker-compose.myrmidon-image.yml"),
    `services:\n  server:\n    image: ${CI_IMAGE}@${OLD}\n`,
  );
  // myrmidon(BOOT-PATH): deploy.sh verifies the boot unit; give the sandbox the canonical
  // one in a sandbox dir (the same template the deploy scripts ship).
  const unitDir = path.join(dir, "systemd");
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = fs.readFileSync(path.join(HERE, "paperclip.service.template"), "utf8")
    .replaceAll("__COMPOSE_DIR__", composeDir)
    .replaceAll("__COMPOSE_FILE_ARGS__", `-f ${composeDir}/docker-compose.yml -f ${composeDir}/docker-compose.myrmidon-image.yml`)
    .replaceAll("__COMPOSE_SERVICE__", "server");
  fs.writeFileSync(path.join(unitDir, "paperclip.service"), unit);

  const lines = [
    `COMPOSE_DIR=${composeDir}`,
    "COMPOSE_SERVICE=server",
    "HEALTH_URL=http://127.0.0.1:3100/api/health",
    "HEALTH_TIMEOUT_SEC=2",
    "POLL_INTERVAL_SEC=1",
    `STATE_DIR=${path.join(dir, "state")}`,
    `DUMP_DIR=${path.join(dir, "dumps")}`,
    `DUMP_COMMAND='head -c 2048 /dev/zero > "$DUMP_FILE"'`,
    "MAINTENANCE_MODE=hook",
    `MAINTENANCE_ENTER_COMMAND='echo enter >> ${path.join(dir, "maintenance.log")}'`,
    `MAINTENANCE_EXIT_COMMAND='echo exit >> ${path.join(dir, "maintenance.log")}'`,
    "RUNNING_RUNS_COMMAND='echo 0'",
    `SYSTEMD_UNIT_DIR=${unitDir}`,
    "MYR_DOCKERGATE_HEALTH_URL=http://127.0.0.1:3100/dockergate/health",
    "MYR_FLEETD_HEALTH_URL=http://127.0.0.1:3100/fleetd/health",
    "MYRMIDON_DEPLOY_SMOKE=0",
  ];
  if (tracing) {
    fs.writeFileSync(path.join(dir, "effective-callbacks"), `${tracing.effectiveCallbacks.join("\n")}\n`);
    lines.push(
      `MYRMIDON_TRACING_LANGFUSE_URL=${LANGFUSE_URL}`,
      `MYRMIDON_TRACING_CALLBACKS_COMMAND='cat ${path.join(dir, "effective-callbacks")}'`,
    );
  }
  lines.push("");
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(config, lines.join("\n"));
  return { dir, bin, config };
}

function runDeploy(sandbox, args = []) {
  const result = spawnSync(bashPath(), [path.join(HERE, "deploy.sh"), "--config", sandbox.config, ...args], {
    env: baseEnv(sandbox),
    encoding: "utf8",
    timeout: 120000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const maintenance = (sb) => (fs.existsSync(path.join(sb.dir, "maintenance.log")) ? fs.readFileSync(path.join(sb.dir, "maintenance.log"), "utf8") : "");

describe("deploy.sh tracing guard", () => {
  it("refuses the deploy when the legacy callback is effective against a v4 server", () => {
    const sb = deploySandbox({ tracing: { effectiveCallbacks: [LEGACY, OTLP] } });
    const { code, out } = runDeploy(sb, ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /legacy 'langfuse' callback/);
    assert.match(out, /cannot be skipped/);
    // Same contract as a failed health check: the window stays on so the
    // operator fixes the gateway and runs the deploy again.
    assert.equal(maintenance(sb), "enter\n");
  });

  it("passes the deploy with the OTLP-only callbacks", () => {
    const sb = deploySandbox({ tracing: { effectiveCallbacks: [OTLP] } });
    const { code, out } = runDeploy(sb, ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /callbacks ok \(OTLP only\)/);
    assert.equal(maintenance(sb), "enter\nexit\n");
  });

  it("skips the guard when no tracing input is configured", () => {
    const sb = deploySandbox();
    const { code, out } = runDeploy(sb, ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /the callback check is skipped/);
  });
});