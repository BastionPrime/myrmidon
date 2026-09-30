import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real deploy-from-job.sh against fake `docker`, `curl` and `git`
// first in PATH, the same harness pattern deploy.test.mjs uses. The fake
// board answers from files in the sandbox; no test touches a real board,
// registry or docker daemon.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";
const JOB_ID = "11111111-2222-4333-8444-555555555555";

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
    if [ -e "$SANDBOX/registry-missing" ]; then echo "ERROR: $4: not found" >&2; exit 1; fi
    cat "$SANDBOX/imagetools.json" ;;
  compose) exit 0 ;;
esac
`;

const FAKE_GIT = `#!/usr/bin/env bash
echo "git $*" >> "$SANDBOX/calls.log"
while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  rev-parse) echo "$SANDBOX/clone" ;;
  remote) cat "$SANDBOX/git-origin" ;;
  fetch) ;;
  merge-base) exit 0 ;;
  ls-remote) cat "$SANDBOX/git-tags" ;;
esac
`;

// The fake board: the deploy-jobs endpoint serves $SANDBOX/board-jobs.json,
// the maintenance endpoint $SANDBOX/board-maintenance.json. Writing those
// files from a test simulates the board moving the job forward.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *myrmidon/deploy-jobs*) cat "$SANDBOX/board-jobs.json" ;;
  *myrmidon/maintenance*) cat "$SANDBOX/board-maintenance.json" ;;
  *api/health*) cat "$SANDBOX/health.json" ;;
  *) echo "{}" ;;
esac
`;

function sandbox({ job = null, windowState = "on", health } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-from-job-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(
    path.join(dir, "board-jobs.json"),
    JSON.stringify(job ? { job: { ...job, digest: job.digest ?? NEW }, history: [] } : { job: null, history: [] }),
  );
  fs.writeFileSync(path.join(dir, "board-maintenance.json"), JSON.stringify({ active: true, instance: { state: windowState }, windows: [] }));
  fs.writeFileSync(
    path.join(dir, "imagetools.json"),
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { Env: ["A=1"], Labels: { "org.opencontainers.image.revision": COMMIT, "org.opencontainers.image.source": SOURCE, "org.opencontainers.image.version": VERSION } },
    }),
  );
  fs.writeFileSync(path.join(dir, "git-origin"), `${ORIGIN}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), "");
  fs.writeFileSync(path.join(dir, "label-version"), `${VERSION}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${COMMIT}\n`);
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(health ?? { status: "ok", version: VERSION, commit: COMMIT }));
  const override = path.join(composeDir, "docker-compose.myrmidon-image.yml");
  fs.writeFileSync(override, `services:\n  server:\n    image: ${CI_IMAGE}@${OLD}\n`);
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
      `DUMP_COMMAND='head -c 2048 /dev/zero > "$DUMP_FILE"'`,
      "MAINTENANCE_MODE=hook",
      `MAINTENANCE_ENTER_COMMAND='echo enter >> ${path.join(dir, "maintenance.log")}'`,
      `MAINTENANCE_EXIT_COMMAND='echo exit >> ${path.join(dir, "maintenance.log")}'`,
      "RUNNING_RUNS_COMMAND='echo 0'",
      `BOARD_API_URL=http://127.0.0.1:3100/api`,
      "",
    ].join("\n"),
  );
  return { dir, bin, config, override };
}

function run(sb, args) {
  const result = spawnSync(
    process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
    [path.join(HERE, "deploy-from-job.sh"), "--config", sb.config, ...args],
    { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const report = (sb) => {
  const file = path.join(sb.dir, "state", `job-${JOB_ID}.json`);
  return fs.existsSync(file) ? JSON.parse(read(file)) : null;
};
const calls = (sb) => read(path.join(sb.dir, "calls.log"));

describe("deploy-from-job.sh", () => {
  it("passes when there is no dispatchable job (--once exits 0)", () => {
    const sb = sandbox({ job: null });
    const { code, out } = run(sb, ["--once"]);
    assert.equal(code, 0, out);
    assert.equal(report(sb), null);
    // It did poll the board.
    assert.match(calls(sb), /myrmidon\/deploy-jobs/);
  });

  it("runs deploy.sh for a dispatchable job and reports health-ok", () => {
    const sb = sandbox({ job: { id: JOB_ID, status: "maintenance_on", digest: NEW } });
    const { code, out } = run(sb, ["--once"]);
    assert.equal(code, 0, out);
    const r = report(sb);
    assert.equal(r.jobId, JOB_ID);
    assert.equal(r.phase, "health-ok");
    assert.equal(r.version, VERSION);
    assert.equal(r.commit, COMMIT);
    // The image switch went through deploy.sh (pull + compose up).
    assert.match(calls(sb), new RegExp(`docker pull --quiet ${CI_IMAGE}@${NEW}`));
    assert.match(read(sb.override), new RegExp(`image: ${CI_IMAGE}@${NEW}`));
  });

  it("reports health-failed when deploy.sh fails the health check", () => {
    const sb = sandbox({
      job: { id: JOB_ID, status: "maintenance_on", digest: NEW },
      health: { status: "ok", version: "0.0.0", commit: COMMIT },
    });
    const { code } = run(sb, ["--once"]);
    // The executor itself succeeds: the failure is reported, not hidden.
    assert.equal(code, 0);
    const r = report(sb);
    assert.equal(r.phase, "health-failed");
    assert.match(r.detail, /exit 1/);
  });

  it("waits until the maintenance window is on before switching", () => {
    // Window starts "entering"; the fake board turns it "on" only after the
    // first maintenance poll — simulated by a curl that flips the file.
    const sb = sandbox({ job: { id: JOB_ID, status: "maintenance_on", digest: NEW }, windowState: "entering" });
    const flip = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *myrmidon/deploy-jobs*) cat "$SANDBOX/board-jobs.json" ;;
  *myrmidon/maintenance*)
    if [ ! -e "$SANDBOX/seen-entering" ]; then
      touch "$SANDBOX/seen-entering"
      printf '{"active":true,"instance":{"state":"entering"},"windows":[]}'
    else
      printf '{"active":true,"instance":{"state":"on"},"windows":[]}'
    fi ;;
  *api/health*) cat "$SANDBOX/health.json" ;;
  *) echo "{}" ;;
esac
`;
    fs.writeFileSync(path.join(sb.bin, "curl"), flip, { mode: 0o755 });
    const { code, out } = run(sb, ["--once"]);
    assert.equal(code, 0, out);
    assert.equal(report(sb).phase, "health-ok");
    // The first maintenance read saw entering: the switch waited.
    assert.ok(fs.existsSync(path.join(sb.dir, "seen-entering")));
  });

  it("reports an error when the window never reaches on", () => {
    const sb = sandbox({ job: { id: JOB_ID, status: "maintenance_on", digest: NEW }, windowState: "entering" });
    const { code } = run(sb, ["--once", "--timeout", "1"]);
    assert.equal(code, 0);
    const r = report(sb);
    assert.equal(r.phase, "error");
    assert.match(r.detail, /never reached on/);
    // No pull happened: the image was never switched.
    assert.doesNotMatch(calls(sb), /docker pull/);
  });

  it("--dry-run changes nothing and reports the plan", () => {
    const sb = sandbox({ job: { id: JOB_ID, status: "maintenance_on", digest: NEW } });
    const { code, out } = run(sb, ["--once", "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /would run/);
    assert.match(out, /deploy\.sh --config/);
    // No real pull, no override change, no lock directory left behind.
    assert.doesNotMatch(calls(sb), /docker pull --quiet/);
    assert.match(read(sb.override), new RegExp(`image: ${CI_IMAGE}@${OLD}`));
    assert.equal(fs.existsSync(path.join(sb.dir, "state", "executor.lock")), false);
  });

  it("refuses to run a second executor while one holds the lock", () => {
    const sb = sandbox({ job: null });
    const state = path.join(sb.dir, "state");
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(path.join(state, "executor.lock"));
    const { code, out } = run(sb, ["--once"]);
    assert.notEqual(code, 0);
    assert.match(out, /refusing to run two/);
  });

  it("reports error when the job digest fails the CI image check inside deploy.sh", () => {
    const sb = sandbox({ job: { id: JOB_ID, status: "maintenance_on", digest: NEW } });
    fs.writeFileSync(path.join(sb.dir, "registry-missing"), "");
    const { code } = run(sb, ["--once"]);
    assert.equal(code, 0);
    const r = report(sb);
    assert.equal(r.phase, "health-failed");
    assert.match(r.detail, /exit 1/);
    // deploy.sh refused before the pull.
    assert.doesNotMatch(calls(sb), /docker pull --quiet/);
  });
});
