import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real deploy scripts against fake `docker` and `curl` placed first
// in PATH. The fakes log every call and answer from files in the sandbox.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  pull) exit "\${FAKE_PULL_EXIT:-0}" ;;
  image)
    case "$*" in
      *org.opencontainers.image.version*) cat "$SANDBOX/label-version" ;;
      *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision" ;;
    esac ;;
  compose) exit 0 ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
cat "$SANDBOX/health.json"
`;

const VENDOR = "ghcr.io/paperclipai/paperclip:2026.916.1";

function sandbox({ health, dumpBytes = 2048, labelVersion = VERSION, labelRevision = COMMIT, current = OLD, currentImage } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-deploy-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "label-version"), `${labelVersion}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${labelRevision}\n`);
  fs.writeFileSync(
    path.join(dir, "health.json"),
    JSON.stringify(health ?? { status: "ok", version: VERSION, commit: COMMIT }),
  );
  const override = path.join(composeDir, "docker-compose.myrmidon-image.yml");
  if (currentImage) {
    fs.writeFileSync(override, `services:\n  server:\n    image: ${currentImage}\n`);
  } else if (current) {
    fs.writeFileSync(override, `services:\n  server:\n    image: ghcr.io/itkadr-git/myrmidon@${current}\n`);
  }
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      `COMPOSE_DIR=${composeDir}`,
      "COMPOSE_SERVICE=server",
      "HEALTH_URL=http://127.0.0.1:3100/api/health",
      "HEALTH_TIMEOUT_SEC=2",
      "POLL_INTERVAL_SEC=1",
      `STATE_DIR=${path.join(dir, "state")}`,
      `DUMP_DIR=${path.join(dir, "dumps")}`,
      `DUMP_COMMAND='head -c ${dumpBytes} /dev/zero > "$DUMP_FILE"'`,
      "MAINTENANCE_MODE=hook",
      `MAINTENANCE_ENTER_COMMAND='echo enter >> ${path.join(dir, "maintenance.log")}'`,
      `MAINTENANCE_EXIT_COMMAND='echo exit >> ${path.join(dir, "maintenance.log")}'`,
      "RUNNING_RUNS_COMMAND='echo 0'",
      "",
    ].join("\n"),
  );
  return { dir, bin, config, override };
}

function run(sb, script, args, input) {
  const result = spawnSync("bash", [path.join(HERE, script), "--config", sb.config, ...args], {
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
    encoding: "utf8",
    input,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));
const maintenance = (sb) => read(path.join(sb.dir, "maintenance.log"));

describe("deploy.sh", () => {
  it("deploys by digest: dump, maintenance, image switch, health, exit", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(read(sb.override), new RegExp(`image: ghcr.io/itkadr-git/myrmidon@${NEW}`));
    assert.equal(read(path.join(sb.dir, "state/previous-digest")).trim(), OLD);
    assert.equal(fs.readdirSync(path.join(sb.dir, "dumps")).length, 1);
    assert.match(calls(sb), new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon@${NEW}`));
    assert.match(calls(sb), /docker compose .* up -d --no-deps server/);
    assert.equal(maintenance(sb), "enter\nexit\n");
  });

  it("fails on a version mismatch, keeps maintenance on and prints the rollback command", () => {
    const sb = sandbox({ health: { status: "ok", version: "2026.916.1-myr.0", commit: COMMIT } });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /version mismatch/);
    assert.match(out, /rollback\.sh --config/);
    assert.equal(maintenance(sb), "enter\n");
  });

  it("fails on a commit mismatch", () => {
    const sb = sandbox({ health: { status: "ok", version: VERSION, commit: "f".repeat(40) } });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /commit mismatch/);
  });

  it("refuses an empty dump before touching the image", () => {
    const sb = sandbox({ dumpBytes: 0 });
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /dump .* empty/);
    assert.equal(read(sb.override), before);
    assert.doesNotMatch(calls(sb), /compose/);
    assert.equal(maintenance(sb), "");
  });

  it("--dry-run changes nothing and prints the plan", () => {
    const sb = sandbox();
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /Plan:/);
    assert.match(out, /docker pull/);
    assert.equal(read(sb.override), before);
    assert.equal(calls(sb), "");
    assert.equal(maintenance(sb), "");
    assert.ok(!fs.existsSync(path.join(sb.dir, "dumps")));
  });

  it("rejects a malformed digest", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", "latest"]);
    assert.notEqual(code, 0);
    assert.match(out, /sha256/);
  });

  it("aborts before the image switch when running runs cannot be counted", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "RUNNING_RUNS_COMMAND='exit 3'\n");
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /cannot count running runs/);
    assert.equal(read(sb.override), before);
    assert.doesNotMatch(calls(sb), /up -d/);
  });

  it("aborts when the run counter prints nothing, unless ALLOW_UNKNOWN_RUNS=1", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "RUNNING_RUNS_COMMAND='true'\n");
    assert.notEqual(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    fs.appendFileSync(sb.config, "ALLOW_UNKNOWN_RUNS=1\n");
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /ALLOW_UNKNOWN_RUNS=1, not waiting/);
  });

  it("--force on the same image recreates the container and keeps the real previous image", () => {
    const sb = sandbox({ current: OLD });
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--force"]);
    assert.equal(code, 0, out);
    assert.match(calls(sb), /up -d --no-deps --force-recreate server/);
    assert.equal(read(path.join(sb.dir, "state/previous-digest")).trim(), OLD);
    assert.equal(read(path.join(sb.dir, "state/previous-image")).trim(), `ghcr.io/itkadr-git/myrmidon@${OLD}`);
  });

  it("aborts when runs do not finish in time", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "RUNNING_RUNS_COMMAND='echo 3'\nRUNS_WAIT_TIMEOUT_SEC=0\n");
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /still in progress/);
    assert.equal(read(sb.override), before);
  });
});

describe("rollback.sh", () => {
  it("returns to the previous digest without restoring the database", () => {
    const sb = sandbox();
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    const { code, out } = run(sb, "rollback.sh", []);
    assert.equal(code, 0, out);
    assert.match(read(sb.override), new RegExp(`@${OLD}`));
    assert.match(out, /database not restored/);
  });

  it("returns to a vendor image after the first deploy from it", () => {
    const sb = sandbox({ currentImage: VENDOR });
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    assert.equal(read(path.join(sb.dir, "state/previous-image")).trim(), VENDOR);
    const { code, out } = run(sb, "rollback.sh", []);
    assert.equal(code, 0, out);
    assert.match(read(sb.override), new RegExp(`image: ${VENDOR.replace(/[.]/g, "\\.")}\\n`));
    assert.match(calls(sb), new RegExp(`docker pull --quiet ${VENDOR.replace(/[.]/g, "\\.")}`));
    assert.equal(read(path.join(sb.dir, "state/previous-image")).trim(), `ghcr.io/itkadr-git/myrmidon@${NEW}`);
  });

  it("--to-image rolls back to any image reference", () => {
    const sb = sandbox({ current: NEW });
    const { code, out } = run(sb, "rollback.sh", ["--to-image", VENDOR]);
    assert.equal(code, 0, out);
    assert.match(read(sb.override), new RegExp(`image: ${VENDOR.replace(/[.]/g, "\\.")}`));
  });

  it("refuses --to together with --to-image", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "rollback.sh", ["--to", OLD, "--to-image", VENDOR]);
    assert.notEqual(code, 0);
    assert.match(out, /not both/);
  });

  it("does not restore a dump without confirmation", () => {
    const sb = sandbox();
    const dump = path.join(sb.dir, "old.dump");
    fs.writeFileSync(dump, "data");
    fs.appendFileSync(sb.config, `RESTORE_COMMAND='echo restored >> ${path.join(sb.dir, "restore.log")}'\n`);
    const { code, out } = run(sb, "rollback.sh", ["--to", OLD, "--restore-dump", dump], "no\n");
    assert.notEqual(code, 0);
    assert.match(out, /not confirmed/);
    assert.equal(read(path.join(sb.dir, "restore.log")), "");
  });

  it("restores a dump after typed confirmation", () => {
    const sb = sandbox({ current: NEW });
    const dump = path.join(sb.dir, "old.dump");
    fs.writeFileSync(dump, "data");
    fs.appendFileSync(sb.config, `RESTORE_COMMAND='echo "$DUMP_FILE" >> ${path.join(sb.dir, "restore.log")}'\n`);
    const { code, out } = run(sb, "rollback.sh", ["--to", OLD, "--restore-dump", dump], "RESTORE\n");
    assert.equal(code, 0, out);
    assert.equal(read(path.join(sb.dir, "restore.log")).trim(), dump);
    assert.match(calls(sb), /compose .* stop server/);
  });
});

describe("verify-health.sh", () => {
  it("fails when the version is hidden and no token is given", () => {
    const sb = sandbox({ health: { status: "ok", commit: COMMIT } });
    const result = spawnSync(
      "bash",
      [path.join(HERE, "verify-health.sh"), "--url", "http://127.0.0.1:3100/api/health", "--expect-version", VERSION, "--expect-commit", COMMIT, "--timeout", "1", "--interval", "1"],
      { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /token-file/);
  });
});
