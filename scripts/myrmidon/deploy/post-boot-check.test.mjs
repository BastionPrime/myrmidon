import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs post-boot-check.sh (POST-BOOT) against fake `docker`, `curl` and
// `systemctl` binaries: the same style as deploy.test.mjs. The fakes answer
// from files in the sandbox, so the checks can be made green or red per test.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const PINNED = `ghcr.io/itkadr-git/myrmidon@sha256:${"b".repeat(64)}`;
const DOCKERGATE = "ghcr.io/itkadr-git/myrmidon-dockergate@sha256:1111111111111111111111111111111111111111111111111111111111111111";

// Fake docker: answers ps/run from sandbox files.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  ps)
    if [[ "$*" == *" -a "* || "$*" == *\\ -a ]]; then
      # docker ps -a: the full list (running + created)
      if [ -e "$SANDBOX/bots-failed" ]; then cat "$SANDBOX/bots-a"; else cat "$SANDBOX/bots-running"; fi
    elif [[ "$*" == *dockergate* ]]; then
      if [ -e "$SANDBOX/dockergate-image" ]; then cat "$SANDBOX/dockergate-image"; fi
    elif [[ "$*" == *name=server* ]]; then
      cat "$SANDBOX/board-image"
    elif [[ "$*" == *name=myrmidon-bot-* ]]; then
      if [ -e "$SANDBOX/bots-failed" ]; then cat "$SANDBOX/bots-empty"; else cat "$SANDBOX/bots-running"; fi
    fi ;;
  run)
    if [ -e "$SANDBOX/dns-fail" ]; then exit 1; fi
    name=""
    for a in "$@"; do case "$a" in mysql|es01|paperclip-server-1) name="$a" ;; esac; done
    echo "resolve $name" ;;
esac
`;

// Fake curl: answers every URL from health.json unless the url is marked down.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
url="$3"
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
for a in "$@"; do case "$a" in (http*|/*) ;; esac; done
if [ -e "$SANDBOX/down-urls" ] && grep -qF "$url" "$SANDBOX/down-urls"; then exit 7; fi
cat "$SANDBOX/health.json"
`;

// Fake systemctl: --failed reads a sandbox file; everything else succeeds.
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$SANDBOX/calls.log"
case "$*" in
  "list-units --state=failed --no-legend") [ -e "$SANDBOX/systemd-failed" ] && cat "$SANDBOX/systemd-failed" ;;
  *) exit 0 ;;
esac
`;

function sandbox({
  health = { status: "ok", version: VERSION, commit: COMMIT },
  boardImage = PINNED,
  dockergate = DOCKERGATE,
  dockergateExpect = DOCKERGATE,
  dockergateDenies = 0,
  botsRunning = ["myrmidon-bot-a", "myrmidon-bot-b"],
  botsFailed = false,
  nginxUp = true,
  dnsFail = false,
  systemdFailed = false,
  extraConfig = "",
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-postboot-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(composeDir, "docker-compose.myrmidon-image.yml"), `services:\n  server:\n    image: ${PINNED}\n`);
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(health));
  fs.writeFileSync(path.join(dir, "bots-running"), botsRunning.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "bots-a"), botsRunning.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "board-image"), `${boardImage}\n`);
  const dockergateLines = Array.from({ length: dockergateDenies }, (_, i) => `deny tar_content/applied_json bot-${i}`);
  fs.writeFileSync(path.join(dir, "dockergate-logs"), dockergateLines.length ? dockergateLines.join("\n") + "\n" : "ok\n");
  fs.writeFileSync(path.join(dir, "dockergate-image"), `${dockergate}\n`);
  if (botsFailed) fs.writeFileSync(path.join(dir, "bots-failed"), "");
  if (botsFailed) fs.writeFileSync(path.join(dir, "bots-empty"), "");
  if (!nginxUp) fs.writeFileSync(path.join(dir, "down-urls"), "http://127.0.0.1/\n");
  if (dnsFail) fs.writeFileSync(path.join(dir, "dns-fail"), "");
  if (systemdFailed) fs.writeFileSync(path.join(dir, "systemd-failed"), "nginx.service loaded failed failed\n");
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      `COMPOSE_DIR=${composeDir}`,
      "COMPOSE_SERVICE=server",
      "HEALTH_URL=http://127.0.0.1:3100/api/health",
      `STATE_DIR=${path.join(dir, "state")}`,
      `DUMP_DIR=${path.join(dir, "dumps")}`,
      "MAINTENANCE_MODE=hook",
      `DOCKERGATE_EXPECT_IMAGE=${dockergateExpect}`,
      `DOCKERGATE_LOGS_COMMAND='cat ${path.join(dir, "dockergate-logs")}'`,
      "NGINX_CHECK_URL=http://127.0.0.1/",
      `DNS_CHECK_NETWORK=${dir.slice(0, 0)}myrmidon`,
      ...extraConfig ? [extraConfig] : [],
      "",
    ].join("\n"),
  );
  return { dir, bin, config };
}

function run(sb, args = []) {
  const result = spawnSync(
    "bash",
    [path.join(HERE, "post-boot-check.sh"), "--config", sb.config, "--timeout", "5", ...args],
    { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

describe("post-boot-check.sh (POST-BOOT)", () => {
  it("reports green on a healthy boot and writes the JSON report", () => {
    const sb = sandbox();
    const report = path.join(sb.dir, "report.json");
    const { code, out } = run(sb, ["--json-out", report]);
    assert.equal(code, 0, out);
    assert.match(out, /post-boot check passed/);
    const json = JSON.parse(read(report));
    assert.equal(json.ok, true);
    assert.equal(json.failed.length, 0);
    assert.ok(json.passed.includes("board health vs pinned image"));
    assert.ok(json.passed.includes("bot containers running, no dockergate denies"));
    assert.ok(json.passed.includes("dns names resolve (mysql es01 paperclip-server-1)"));
    assert.ok(json.passed.includes("systemctl --failed is empty"));
  });

  it("fails when the board runs a different image than the override pins (the 01.10 incident)", () => {
    const sb = sandbox({ boardImage: "ghcr.io/paperclipai/paperclip:2026.916.1" });
    const { code, out } = run(sb, ["--json-out", path.join(sb.dir, "r.json")]);
    assert.notEqual(code, 0, out);
    assert.match(out, /board health vs pinned image FAILED/);
    const json = JSON.parse(read(path.join(sb.dir, "r.json")));
    assert.equal(json.ok, false);
    assert.ok(json.failed.includes("board health vs pinned image"));
  });

  it("fails when dockergate runs another image than the release recorded", () => {
    const sb = sandbox({ dockergate: DOCKERGATE.replace("1111", "2222") });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /dockergate image FAILED/);
  });

  it("fails when dockergate denied applies since boot (the A2 contract)", () => {
    const sb = sandbox({ dockergateDenies: 3 });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /3 dockergate deny line/);
    assert.match(out, /bot containers running, no dockergate denies FAILED/);
  });

  it("fails when a bot container is not running", () => {
    const sb = sandbox({ botsFailed: true });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /bot containers running, no dockergate denies FAILED/);
  });

  it("fails when the board health does not answer ok", () => {
    const sb = sandbox({ health: { status: "maintenance", version: VERSION, commit: COMMIT } });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /board health vs pinned image FAILED/);
  });

  it("fails when nginx is down", () => {
    const sb = sandbox({ nginxUp: false });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /nginx up FAILED/);
  });

  it("fails when a DNS name does not resolve (the RAGFlow lesson)", () => {
    const sb = sandbox({ dnsFail: true });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /does not resolve/);
    assert.match(out, /dns names resolve \(mysql es01 paperclip-server-1\) FAILED/);
  });

  it("fails when systemctl --failed is not empty (release gate extension)", () => {
    const sb = sandbox({ systemdFailed: true });
    const { code, out } = run(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /systemctl --failed is empty FAILED/);
  });

  it("an unset optional URL switches its check off with a log line, not a failure", () => {
    const sb = sandbox();
    // LITELLM/HINDSIGHT/RAGFLOW are unset by default in this sandbox config
    // (sandbox() writes only the NGINX_CHECK_URL).
    const { code, out } = run(sb);
    assert.equal(code, 0, out);
    assert.match(out, /litellm: LITELLM_CHECK_URL not set, check off/);
    assert.match(out, /hindsight: HINDSIGHT_CHECK_URL not set, check off/);
    assert.match(out, /ragflow: RAGFLOW_CHECK_URL not set, check off/);
  });

  it("DOCKERGATE_EXPECT_IMAGE empty switches the dockergate check off with a log line", () => {
    const sb = sandbox({ dockergateExpect: "" });
    const { code, out } = run(sb);
    assert.equal(code, 0, out);
    assert.match(out, /DOCKERGATE_EXPECT_IMAGE not set, check off/);
  });
});
