import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// RELEASE-GATE (the 01.10 incident): integration tests of the release deploy
// flow — deploy.sh must roll the board and the matching component images
// together, refuse a release whose component digests are missing, and report
// DEGRADED when the post-deploy bot smoke fails. Same harness pattern as
// deploy.test.mjs: the real scripts run against fake `docker`, `curl` and
// `git` first in PATH; no test touches a real registry, board or daemon.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const DG = `sha256:${"c".repeat(64)}`;
const FD = `sha256:${"d".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "1.4.0";
const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";
const COMPANY = "2870b911-0000-4000-8000-000000000000";

// The registry answers one inspect per repository. The tag (component
// resolution) and every digest reference (CI check) share it. The component
// digests ride in the answer's .manifest.digest so --format
// '{{json .Manifest.Digest}}' resolves them.
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
    ref="$4"
    # The scripts ask either the whole image JSON ({{json .Image}}, the CI
    # check) or just the index digest ({{json .Manifest.Digest}}, component
    # resolution). Answer from the same registry files either way.
    fmt=""
    for a in "$@"; do case "$a" in --format) fmt=1 ;; esac; case "$a" in *Manifest.Digest*) fmt=digest ;; esac; done
    file=""
    case "$ref" in
      *myrmidon-dockergate*)
        if [ -e "$SANDBOX/components-missing" ]; then echo "ERROR: not found" >&2; exit 1; fi
        file="$SANDBOX/imagetools-dockergate.json" ;;
      *myrmidon-fleetd*)
        if [ -e "$SANDBOX/components-missing" ]; then echo "ERROR: not found" >&2; exit 1; fi
        file="$SANDBOX/imagetools-fleetd.json" ;;
      *)
        if [ -e "$SANDBOX/registry-missing" ]; then echo "ERROR: not found" >&2; exit 1; fi
        file="$SANDBOX/imagetools.json" ;;
    esac
    if [ "$fmt" = "digest" ]; then
      jq -r '.manifest.digest' "$file" | sed 's/^/"/; s/$/"/'
    else
      cat "$file"
    fi ;;
  compose) exit "\${COMPOSE_FAILS:-0}" ;;
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

// The fake board: health, the company agents list, and per-agent
// bot-container status from files the test controls.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *api/health*) cat "$SANDBOX/health.json" ;;
  *bot-container/status*)
    id=""
    for a in "$@"; do case "$a" in *agents/*) id="\${a##*agents/}"; id="\${id%%/*}" ;; esac; done
    if [ -e "$SANDBOX/status-$id.json" ]; then cat "$SANDBOX/status-$id.json"; else echo "{}"; fi ;;
  *agents*) cat "$SANDBOX/agents.json" ;;
  *dockergate/health*|*fleetd/health*)
    if [ -e "$SANDBOX/component-health-bad" ]; then exit 1; fi
    echo "OK" ;;
  *) echo "{}" ;;
esac
`;

function labels(extra = {}) {
  return {
    "org.opencontainers.image.revision": COMMIT,
    "org.opencontainers.image.source": SOURCE,
    "org.opencontainers.image.version": VERSION,
    ...extra,
  };
}

function sandbox({
  health,
  dumpBytes = 2048,
  labelVersion = VERSION,
  labelRevision = COMMIT,
  current = OLD,
  currentImage,
  registryLabels,
  registryMissing = false,
  componentsMissing = false,
  componentHealth = "ok",
  smoke = "ok",
  smokeCompany = COMPANY,
  composeFails = "0",
  origin = ORIGIN,
  tags = "",
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-gate-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  const lbls = registryLabels === undefined ? labels() : registryLabels;
  fs.writeFileSync(
    path.join(dir, "imagetools.json"),
    JSON.stringify({ architecture: "amd64", os: "linux", config: { Env: ["A=1"], Labels: lbls } }),
  );
  // Component registry answers: the tag resolves to the component digest, and
  // the digest reference passes the CI check (same labels).
  fs.writeFileSync(
    path.join(dir, "imagetools-dockergate.json"),
    JSON.stringify({ config: { Labels: labels() }, manifest: { digest: DG } }),
  );
  fs.writeFileSync(
    path.join(dir, "imagetools-fleetd.json"),
    JSON.stringify({ config: { Labels: labels() }, manifest: { digest: FD } }),
  );
  if (registryMissing) fs.writeFileSync(path.join(dir, "registry-missing"), "");
  if (componentsMissing) fs.writeFileSync(path.join(dir, "components-missing"), "");
  if (componentHealth !== "ok") fs.writeFileSync(path.join(dir, "component-health-bad"), "");
  fs.writeFileSync(path.join(dir, "git-origin"), `${origin}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), tags);
  fs.writeFileSync(path.join(dir, "label-version"), `${labelVersion}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${labelRevision}\n`);
  fs.writeFileSync(
    path.join(dir, "health.json"),
    JSON.stringify(health ?? { status: "ok", version: labelVersion, commit: COMMIT }),
  );
  // The board's company agents (one hermes_gateway bot) and its container status.
  const agentId = "77777777-7777-4777-8777-777777777777";
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify([{ id: agentId, adapterType: "hermes_gateway", name: "bot-a" }]),
  );
  const containerState = smoke === "ok" ? "running" : smoke === "created" ? "created" : "missing";
  fs.writeFileSync(
    path.join(dir, `status-${agentId}.json`),
    JSON.stringify({
      enabled: true,
      container: { state: containerState, image: CI_IMAGE },
      containerError: null,
    }),
  );
  const override = path.join(composeDir, "docker-compose.myrmidon-image.yml");
  if (currentImage) {
    fs.writeFileSync(override, `services:\n  server:\n    image: ${currentImage}\n`);
  } else if (current) {
    fs.writeFileSync(override, `services:\n  server:\n    image: ${CI_IMAGE}@${current}\n`);
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
      `BOARD_API_URL=http://127.0.0.1:3100/api`,
      ...(smokeCompany ? [`MYRMIDON_DEPLOY_SMOKE_COMPANY=${smokeCompany}`] : []),
      "MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC=2",
      "MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC=1",
      `MYR_DOCKERGATE_HEALTH_URL=http://127.0.0.1:3100/dockergate/health`,
      `MYR_FLEETD_HEALTH_URL=http://127.0.0.1:3100/fleetd/health`,
      "",
    ].join("\n"),
  );
  return { dir, bin, config, override, composeDir, agentId };
}

function run(sb, script, args) {
  const result = spawnSync(
    process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
    [path.join(HERE, script), "--config", sb.config, ...args],
    {
      env: {
        ...process.env,
        PATH: `${sb.bin}:${process.env.PATH}`,
        SANDBOX: sb.dir,
        COMPOSE_FAILS: sb.composeFails ?? "0",
      },
      encoding: "utf8",
    },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));

describe("deploy.sh: release components roll out together (RELEASE-GATE)", () => {
  it("refuses a release whose component digests are missing, before anything changes", () => {
    const sb = sandbox({ componentsMissing: true });
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /component digests missing/i);
    assert.match(out, /release incomplete/i);
    // Nothing changed: no pull, no dump, no maintenance, no compose.
    assert.equal(read(sb.override), before);
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "dumps")));
    assert.ok(!fs.existsSync(path.join(sb.dir, "state")));
  });

  it("rolls dockergate and fleetd in the same run, each with its own health check", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    const log = calls(sb);
    // The board image, then both components, were pulled by digest.
    assert.match(log, new RegExp(`docker pull --quiet ${CI_IMAGE}@${NEW}`));
    assert.match(log, new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`));
    assert.match(log, new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`));
    // The component override files were written with the resolved digests.
    assert.match(
      read(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")),
      new RegExp(`image: ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`),
    );
    assert.match(
      read(path.join(sb.composeDir, "docker-compose.myrmidon-fleetd.yml")),
      new RegExp(`image: ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`),
    );
    // Each component service was recreated.
    assert.match(log, /up -d --no-deps dockergate/);
    assert.match(log, /up -d --no-deps fleetd/);
    // Each component health URL was probed.
    assert.match(log, /dockergate\/health/);
    assert.match(log, /fleetd\/health/);
    // The smoke saw a running bot container.
    assert.match(out, /re-applied after the deploy/);
    assert.match(out, /release gate passed/);
  });

  it("resolves components by the release tag when the board was built from a tag", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    // The version label is a plain semver (a tag build): resolution used it.
    assert.match(out, /release components \(tag 1\.4\.0\)/);
    // The component registry was asked for the tag, not just sha-.
    assert.match(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:1\.4\.0/);
  });

  it("resolves components by the commit short sha when there is no release tag", () => {
    // A main build between releases: the version label is not a plain semver,
    // so component resolution falls back to the sha-<short> tag.
    const sb = sandbox({
      labelVersion: "1.4.0+3.git.0123456",
      registryLabels: labels({ "org.opencontainers.image.version": "1.4.0+3.git.0123456" }),
    });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /release components \(sha 0123456\)/);
    assert.match(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:sha-0123456/);
  });

  it("reports DEGRADED and prints the rollback commands when the bot smoke fails", () => {
    const sb = sandbox({ smoke: "created" });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /DEGRADED: no bot container re-applied/i);
    assert.match(out, /rollback\.sh --config/);
    assert.match(out, /rollback-component\.sh --config/);
    // The board and the components DID roll out; the failure is the smoke.
    assert.match(calls(sb), new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`));
  });

  it("warns when the smoke cannot run (no company configured)", () => {
    const sb = sandbox({ smokeCompany: "" });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /smoke skipped: MYRMIDON_DEPLOY_SMOKE_COMPANY is not set/);
  });

  it("--dry-run checks the components read-only and prints the plan", () => {
    const sb = sandbox();
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /roll out release components.*dockergate,fleetd/);
    assert.match(out, /post-deploy smoke/);
    // Read-only: the component registry was read, nothing was pulled.
    assert.match(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:1\.4\.0/);
    assert.doesNotMatch(calls(sb), /docker (pull|compose)/);
    assert.equal(read(sb.override), before);
  });
});

describe("rollout-component.sh", () => {
  it("refuses an unknown component", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "nonsense", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /unknown component: nonsense/);
  });

  it("refuses a component image that is not in the registry, changing nothing", () => {
    const sb = sandbox({ componentsMissing: true });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /cannot be read from the registry/);
    assert.doesNotMatch(calls(sb), /docker pull/);
  });

  it("refuses when the component has no health URL configured", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_DOCKERGATE_HEALTH_URL=\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /MYR_DOCKERGATE_HEALTH_URL/);
  });

  it("remembers the previous component image for the rollback", () => {
    const sb = sandbox();
    fs.writeFileSync(
      path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml"),
      `services:\n  dockergate:\n    image: ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}\n`,
    );
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
    assert.equal(
      read(path.join(sb.dir, "state", "previous-dockergate-image")).trim(),
      `ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}`,
    );
  });
});

describe("rollback-component.sh", () => {
  it("returns to the remembered component image", () => {
    const sb = sandbox();
    // A rollout first, so the previous image is remembered.
    fs.writeFileSync(
      path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml"),
      `services:\n  dockergate:\n    image: ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}\n`,
    );
    assert.equal(run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]).code, 0);
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "dockergate"]);
    assert.equal(code, 0, out);
    assert.match(
      read(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")),
      new RegExp(`image: ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}`),
    );
  });

  it("dies with a clear message when no previous component image is recorded", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "dockergate"]);
    assert.notEqual(code, 0);
    assert.match(out, /no previous dockergate image recorded/);
  });
});

describe("bot-apply-smoke.sh", () => {
  function runSmoke(sb, args) {
    const result = spawnSync(
      process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
      [path.join(HERE, "bot-apply-smoke.sh"), ...args],
      { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
    );
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it("succeeds when a bot container is running", () => {
    const sb = sandbox({ smoke: "ok" });
    const { code, out } = runSmoke(sb, [
      "--board-url", "http://127.0.0.1:3100/api",
      "--company", COMPANY,
      "--timeout", "2",
      "--interval", "1",
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /OK: bot container of agent .* is running/);
  });

  it("fails when no bot container re-applies within the window", () => {
    const sb = sandbox({ smoke: "created" });
    const { code, out } = runSmoke(sb, [
      "--board-url", "http://127.0.0.1:3100/api",
      "--company", COMPANY,
      "--timeout", "2",
      "--interval", "1",
    ]);
    assert.notEqual(code, 0);
    assert.match(out, /SMOKE FAILED/);
  });
});
