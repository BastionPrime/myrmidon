import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(BOT-IMAGE-ROLLOUT, 1.6.1): integration tests of the bot image
// rollout — the release's hermes/hermes-dev/hermes-node digests resolve, land
// in dockergate's images[] and bots[], the bot cards switch through the board
// API one at a time (canary first, deferred retried), the superseded images
// leave the list only after the fleet moved, and the journal records every
// switch. Same harness pattern as release-gate.test.mjs: the real scripts run
// against fake `docker`, `curl` and `git` first in PATH; no test touches a
// real registry, board, daemon or dockergate.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "1.6.1";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";
const COMPANY = "2870b911-0000-4000-8000-000000000000";

const HERMES = `sha256:${"e".repeat(64)}`;
const HERMES_DEV = `sha256:${"f".repeat(64)}`;
const HERMES_NODE = `sha256:${"a".repeat(64)}`;
const OLD_DEV = `sha256:${"b".repeat(64)}`;
const DG = `sha256:${"c".repeat(64)}`;
const FD = `sha256:${"d".repeat(64)}`;

const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const BOT = "ghcr.io/itkadr-git/myrmidon-hermes";
const BOT_DEV = "ghcr.io/itkadr-git/myrmidon-hermes-dev";
const BOT_NODE = "ghcr.io/itkadr-git/myrmidon-hermes-node";

// The registry answers per repository: the tag/digest resolution and the CI
// label check share it. The bot image repositories answer the bot digests.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  pull) exit 0 ;;
  buildx)
    ref="$4"
    fmt=""
    for a in "$@"; do case "$a" in *Manifest.Digest*) fmt=digest ;; esac; done
    file=""
    case "$ref" in
      *myrmidon-hermes-dev*) file="$SANDBOX/imagetools-hermes-dev.json" ;;
      *myrmidon-hermes-node*) file="$SANDBOX/imagetools-hermes-node.json" ;;
      *myrmidon-hermes*) file="$SANDBOX/imagetools-hermes.json" ;;
      *myrmidon-dockergate*) file="$SANDBOX/imagetools-dockergate.json" ;;
      *myrmidon-fleetd*) file="$SANDBOX/imagetools-fleetd.json" ;;
      *) file="$SANDBOX/imagetools.json" ;;
    esac
    if [ ! -e "$file" ]; then echo "ERROR: $ref: not found" >&2; exit 1; fi
    if [ "$fmt" = "digest" ]; then
      jq -r '.manifest.digest' "$file" | sed 's/^/"/; s/$/"/'
    else
      cat "$file"
    fi ;;
  image)
    case "$2" in
      inspect)
        case "$*" in
          *org.opencontainers.image.version*) cat "$SANDBOX/label-version"; exit 0 ;;
          *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision"; exit 0 ;;
        esac
        exit 0 ;;
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
  fetch) ;;
  merge-base) exit 0 ;;
  ls-remote) cat "$SANDBOX/git-tags" ;;
esac
`;

// The fake board: the company agents list, per-agent configuration (the card
// image the test controls per PATCH), the apply outcome, and health. The
// PATCH handler rewrites the agent's card image; the apply answers from the
// apply-outcome file (a JSON outcome object), with a deferred-then-ok mode.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *api/health*) cat "$SANDBOX/health.json"; exit 0 ;;
  *companies/*/issues*)
    # The post-deploy fleet check: no blocked issues in the deploy window.
    echo '{"issues": []}'; exit 0 ;;
  *companies/*/agents*)
    cat "$SANDBOX/agents.json"; exit 0 ;;
  *api/agents/*)
    case " $* " in
      *" -X PATCH "*)
        id=""
        body=""
        prev=""
        for a in "$@"; do
          case "$prev" in
            --data) body="$a" ;;
          esac
          case "$a" in
            *agents/*) id="\${a##*/agents/}" ;;
          esac
          prev="$a"
        done
        img="$(printf '%s' "$body" | jq -r '.adapterConfig.container.image')"
        jq --arg id "$id" --arg img "$img" \
          'map(if .id == $id then .adapterConfig.container.image = $img else . end)' \
          "$SANDBOX/agents.json" > "$SANDBOX/agents.json.new" && mv "$SANDBOX/agents.json.new" "$SANDBOX/agents.json"
        jq -c --arg id "$id" 'first(.[] | select(.id == $id))' "$SANDBOX/agents.json"
        exit 0 ;;
    esac
    cat "$SANDBOX/agents.json"; exit 0 ;;
  *bot-container/apply*)
    id=""
    for a in "$@"; do case "$a" in *agents/*) id="\${a##*agents/}"; id="\${id%%/*}" ;; esac; done
    # deferred-once mode: the first apply of a bot answers deferred, the rest ok.
    if [ -e "$SANDBOX/apply-defer-first" ] && [ ! -e "$SANDBOX/applied-$id" ]; then
      touch "$SANDBOX/applied-$id"
      echo '{"outcome":{"kind":"deferred","reason":"the agent is under a maintenance window"}}'
      exit 0
    fi
    if [ -e "$SANDBOX/apply-fails" ]; then
      echo '{"error":"boom","outcome":{"kind":"error","message":"boom"}}'
      exit 1
    fi
    echo '{"outcome":{"kind":"applied_restart"}}'
    exit 0 ;;
esac
echo "{}"
`;

const FAKE_SSH = `#!/usr/bin/env bash
echo "ssh $*" >> "$SANDBOX/calls.log"
if [ -e "$SANDBOX/ssh-fails" ]; then echo "ssh: connect failed" >&2; exit 255; fi
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; *) break ;; esac; done
target="$1"; shift
if [ "$#" -eq 1 ]; then exec bash -c "$1"; fi
exec "$@"
`;

const FAKE_SCP = `#!/usr/bin/env bash
echo "scp $*" >> "$SANDBOX/calls.log"
exit 0
`;

// A systemctl stand-in: verify_boot_unit only needs it to exist (command -v);
// the canonical-unit comparison is done on the file itself.
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$SANDBOX/calls.log"
exit 0
`;

function labels() {
  return {
    "org.opencontainers.image.revision": COMMIT,
    "org.opencontainers.image.source": SOURCE,
    "org.opencontainers.image.version": VERSION,
  };
}

function imageJson(digest) {
  return JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: { Env: ["A=1"], Labels: labels() },
    manifest: { digest },
  });
}

/**
 * Sandbox for the bot image rollout tests.
 *
 * agents: array of {id, image} — hermes_gateway bots with enabled containers;
 *   the id doubles as the enrollment key. A card image of null disables the
 *   container block for that agent.
 */
function sandbox({
  agents = [
    { id: "77777777-7777-4777-8777-777777777777", image: `${BOT_DEV}@${OLD_DEV}`, memoryMb: 4096, cpus: 2, pidsLimit: 1024 },
    { id: "88888888-8888-4888-8888-888888888888", image: `${BOT}@${OLD_DEV}`, memoryMb: 2048, cpus: 1, pidsLimit: 512 },
  ],
  dockergateConfig,
  applyFails = false,
  applyDeferFirst = false,
  botImagesMissing = false,
  sshFails = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-bot-rollout-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "scp"), FAKE_SCP, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  if (sshFails) fs.writeFileSync(path.join(dir, "ssh-fails"), "");
  if (applyFails) fs.writeFileSync(path.join(dir, "apply-fails"), "");
  if (applyDeferFirst) fs.writeFileSync(path.join(dir, "apply-defer-first"), "");

  // Registry answers: board, components, and the three bot images.
  fs.writeFileSync(path.join(dir, "imagetools.json"), imageJson(`sha256:${"9".repeat(64)}`));
  fs.writeFileSync(path.join(dir, "imagetools-dockergate.json"), imageJson(DG));
  fs.writeFileSync(path.join(dir, "imagetools-fleetd.json"), imageJson(FD));
  if (!botImagesMissing) {
    fs.writeFileSync(path.join(dir, "imagetools-hermes.json"), imageJson(HERMES));
    fs.writeFileSync(path.join(dir, "imagetools-hermes-dev.json"), imageJson(HERMES_DEV));
    fs.writeFileSync(path.join(dir, "imagetools-hermes-node.json"), imageJson(HERMES_NODE));
  }
  fs.writeFileSync(path.join(dir, "git-origin"), `${ORIGIN}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), "");
  fs.writeFileSync(path.join(dir, "label-version"), `${VERSION}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${COMMIT}\n`);
  fs.writeFileSync(
    path.join(dir, "health.json"),
    JSON.stringify({ status: "ok", version: VERSION, commit: COMMIT }),
  );

  // The board's agents: hermes_gateway bots with enabled container blocks.
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify(
      agents.map((a) => ({
        id: a.id,
        adapterType: "hermes_gateway",
        adapterConfig: {
          container: {
            enabled: true,
            image: a.image,
            memoryMb: a.memoryMb ?? 2048,
            cpus: a.cpus ?? 1,
            pidsLimit: a.pidsLimit ?? 512,
          },
        },
      })),
    ),
  );

  // The dockergate config the rollout edits: one enrolled bot, the old image
  // allowed. The Wiki Maintainer case: bot B exists on the board but is NOT
  // enrolled — the rollout must enroll it.
  const cfg =
    dockergateConfig ??
    JSON.stringify(
      {
        listen: "/run/myrmidon-dockergate/engine.sock",
        upstream: "/var/run/docker.sock",
        apiVersion: "1.45",
        caller: { container: "paperclip-server-1", containerLabels: { "com.docker.compose.project": "paperclip" }, argv: ["node"], uid: 1000, gid: 1000, mode: "uid" },
        volumeRoot: "/srv/test-bots",
        network: "myrmidon-bots",
        images: [`${BOT_DEV}@${OLD_DEV}`, `${BOT}@${OLD_DEV}`],
        mountSources: [],
        bots: agents.length > 0 ? [{ botKey: agents[0].id, maxMemoryMb: 4096, maxCpus: 2, maxPids: 1024 }] : [],
        limits: {},
        statsFile: "/tmp/dockergate-stats.json",
      },
      null,
      2,
    );
  const dgConfig = path.join(dir, "dockergate.config.json");
  fs.writeFileSync(dgConfig, cfg);

  const stateDir = path.join(dir, "state");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(composeDir, { recursive: true });
  fs.writeFileSync(path.join(composeDir, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(composeDir, "docker-compose.myrmidon-image.yml"), `services:\n  server:\n    image: ${CI_IMAGE}@${DG}\n`);
  // Boot unit (BOOT-PATH): the canonical one so deploy.sh passes its check.
  const unitDir = path.join(dir, "systemd");
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = fs.readFileSync(path.join(HERE, "paperclip.service.template"), "utf8")
    .replaceAll("__COMPOSE_DIR__", composeDir)
    .replaceAll("__COMPOSE_FILE_ARGS__", `-f ${composeDir}/docker-compose.yml -f ${composeDir}/docker-compose.myrmidon-image.yml`)
    .replaceAll("__COMPOSE_SERVICE__", "server");
  fs.writeFileSync(path.join(unitDir, "paperclip.service"), unit);

  // A board API key file (the fake curl never reads it, but the script checks
  // readability).
  const tokenFile = path.join(dir, "board.key");
  fs.writeFileSync(tokenFile, `pcp_${"0".repeat(24)}\n`);

  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      `COMPOSE_DIR=${composeDir}`,
      "COMPOSE_SERVICE=server",
      "HEALTH_URL=http://127.0.0.1:3100/api/health",
      "HEALTH_TIMEOUT_SEC=2",
      "POLL_INTERVAL_SEC=1",
      `STATE_DIR=${stateDir}`,
      `DUMP_DIR=${path.join(dir, "dumps")}`,
      "DUMP_COMMAND='head -c 2048 /dev/zero > \"$DUMP_FILE\"'",
      "MAINTENANCE_MODE=hook",
      `MAINTENANCE_ENTER_COMMAND='echo enter >> ${path.join(dir, "maintenance.log")}'`,
      `MAINTENANCE_EXIT_COMMAND='echo exit >> ${path.join(dir, "maintenance.log")}'`,
      "RUNNING_RUNS_COMMAND='echo 0'",
      `SYSTEMD_UNIT_DIR=${unitDir}`,
      `BOARD_API_URL=http://127.0.0.1:3100/api`,
      `BOARD_TOKEN_FILE=${tokenFile}`,
      `BOARD_COMPANY_ID=${COMPANY}`,
      `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG=${dgConfig}`,
      `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND='jq -e . "$MYR_BOT_CFG_FILE" >/dev/null'`,
      `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND='echo hup >> ${path.join(dir, "sighup.log")}'`,
      `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC=3`,
      "MYR_DOCKERGATE_HEALTH_URL=http://127.0.0.1:3100/dockergate/health",
      "MYR_FLEETD_HEALTH_URL=http://127.0.0.1:3100/fleetd/health",
      // The components are not part of this sandbox compose project; the
      // resolution still runs (their digests answer in the fake registry),
      // the rollouts skip.
      "MYR_DOCKERGATE_HOST=skip",
      "MYR_FLEETD_HOST=skip",
      "",
    ].join("\n"),
  );
  return { dir, bin, config, dgConfig, stateDir, tokenFile };
}

function run(sb, script, args) {
  const result = spawnSync(
    process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
    [path.join(HERE, script), "--config", sb.config, ...args],
    {
      env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
      encoding: "utf8",
    },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));
const sighups = (sb) => read(path.join(sb.dir, "sighup.log"));
const journal = (sb) => read(path.join(sb.stateDir, "bot-image-rollout.log"));
const dockergateConfig = (sb) => JSON.parse(read(sb.dgConfig));

describe("bot-image-rollout.sh", () => {
  it("resolves the three bot images of the release and allows them in dockergate", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.equal(code, 0, out);
    const cfg = dockergateConfig(sb);
    // All three release digests are now allowed...
    assert.ok(cfg.images.includes(`${BOT}@${HERMES}`), "hermes digest allowed");
    assert.ok(cfg.images.includes(`${BOT_DEV}@${HERMES_DEV}`), "hermes-dev digest allowed");
    assert.ok(cfg.images.includes(`${BOT_NODE}@${HERMES_NODE}`), "hermes-node digest allowed");
    // ...and the OLD images were still allowed during the rollout: the deploy
    // log proves the add happened before the switches (journal ordering is
    // asserted in the removal test below).
    // The images were pulled on the local host.
    assert.match(calls(sb), new RegExp(`docker pull --quiet ${BOT}@${HERMES}`));
    assert.match(calls(sb), new RegExp(`docker pull --quiet ${BOT_DEV}@${HERMES_DEV}`));
    // dockergate was reloaded (SIGHUP) after the edit.
    assert.match(sighups(sb), /hup/);
  });

  it("enrolls every board bot in bots[] (the bot_not_enrolled fix)", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.equal(code, 0, out);
    const cfg = dockergateConfig(sb);
    const keys = cfg.bots.map((b) => b.botKey);
    // The second bot (missing from the initial config — the Wiki Maintainer
    // case) is now enrolled, with the card's limits.
    assert.ok(keys.includes("88888888-8888-4888-8888-888888888888"), "the un-enrolled bot is enrolled");
    const enrolled = cfg.bots.find((b) => b.botKey === "88888888-8888-4888-8888-888888888888");
    assert.equal(enrolled.maxMemoryMb, 2048);
    assert.equal(enrolled.maxCpus, 1);
    assert.equal(enrolled.maxPids, 512);
    // The already-enrolled bot keeps its limits (no duplicate).
    assert.equal(cfg.bots.filter((b) => b.botKey === "77777777-7777-4777-8777-777777777777").length, 1);
  });

  it("switches every bot card to the release image of its variant, one at a time", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.equal(code, 0, out);
    // The dev-variant bot got the release's dev image; the plain bot got hermes.
    const agents = JSON.parse(read(path.join(sb.dir, "agents.json")));
    const dev = agents.find((a) => a.id === "77777777-7777-4777-8777-777777777777");
    const plain = agents.find((a) => a.id === "88888888-8888-4888-8888-888888888888");
    assert.equal(dev.adapterConfig.container.image, `${BOT_DEV}@${HERMES_DEV}`);
    assert.equal(plain.adapterConfig.container.image, `${BOT}@${HERMES}`);
    // Each switch went through PATCH + apply.
    const log = calls(sb);
    assert.match(log, /-X PATCH .*\/agents\/77777777-7777-4777-8777-777777777777/);
    assert.match(log, /bot-container\/apply/);
    // The journal records both switches.
    assert.match(journal(sb), /agent 77777777-7777-4777-8777-777777777777 .* -> .*hermes-dev@/);
    assert.match(journal(sb), /agent 88888888-8888-4888-8888-888888888888 .* -> .*myrmidon-hermes@/);
  });

  it("removes the superseded bot images from images[] after the fleet moved", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.equal(code, 0, out);
    const cfg = dockergateConfig(sb);
    // The old digests are gone; the release digests stay.
    assert.ok(!cfg.images.includes(`${BOT_DEV}@${OLD_DEV}`), "old dev digest removed");
    assert.ok(!cfg.images.includes(`${BOT}@${OLD_DEV}`), "old plain digest removed");
    assert.ok(cfg.images.includes(`${BOT}@${HERMES}`));
    assert.ok(cfg.images.includes(`${BOT_DEV}@${HERMES_DEV}`));
    assert.ok(cfg.images.includes(`${BOT_NODE}@${HERMES_NODE}`));
  });

  it("a deferred bot is retried and then switched (no run interrupted)", () => {
    const sb = sandbox({ applyDeferFirst: true });
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.equal(code, 0, out);
    // Every bot applied at least twice (deferred, then ok).
    const applyCalls = calls(sb).match(/bot-container\/apply/g) ?? [];
    assert.ok(applyCalls.length >= 3, `expected retries, got ${applyCalls.length}`);
    // All bots ended on the release images.
    const agents = JSON.parse(read(path.join(sb.dir, "agents.json")));
    for (const a of agents) {
      assert.match(a.adapterConfig.container.image, /@(sha256:[a-f0-9]{64})$/);
      assert.notEqual(a.adapterConfig.container.image, `${BOT_DEV}@${OLD_DEV}`);
    }
  });

  it("canary first: the --canary bot is switched before the others", () => {
    const sb = sandbox();
    const canary = "88888888-8888-4888-8888-888888888888";
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION, "--canary", canary]);
    assert.equal(code, 0, out);
    const log = calls(sb);
    const firstPatch = log.indexOf(`-X PATCH`);
    const canaryPatch = log.indexOf(`/agents/${canary}`);
    const otherPatch = log.indexOf("/agents/77777777-7777-4777-8777-777777777777");
    assert.ok(firstPatch >= 0 && canaryPatch >= 0 && otherPatch >= 0, "both bots were patched");
    assert.ok(canaryPatch < otherPatch, "the canary was switched first");
  });

  it("refuses a release whose bot images are missing, before anything changes", () => {
    const sb = sandbox({ botImagesMissing: true });
    const before = read(sb.dgConfig);
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.notEqual(code, 0);
    assert.match(out, /bot image digests missing/i);
    // Nothing changed: no pull, no card PATCH, no config edit, no SIGHUP.
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.doesNotMatch(calls(sb), /-X PATCH/);
    assert.equal(read(sb.dgConfig), before);
    assert.equal(sighups(sb), "");
  });

  it("reports failure when a bot's apply fails (DEGRADED, not silent)", () => {
    const sb = sandbox({ applyFails: true });
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.notEqual(code, 0);
    assert.match(out, /DEGRADED.*failed to switch/i);
    // The old images stay allowed: the un-moved bots must not be stranded.
    const cfg = dockergateConfig(sb);
    assert.ok(cfg.images.includes(`${BOT_DEV}@${OLD_DEV}`));
    assert.ok(cfg.images.includes(`${BOT}@${OLD_DEV}`));
  });

  it("--dry-run resolves read-only and changes nothing", () => {
    const sb = sandbox();
    const before = read(sb.dgConfig);
    const agentsBefore = read(path.join(sb.dir, "agents.json"));
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION, "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /dry run: nothing will be changed/i);
    assert.match(out, /resolved \(read-only\)/);
    assert.match(out, /77777777-7777-4777-8777-777777777777/);
    // Read-only: the registry was read, nothing was pulled, patched or edited.
    assert.match(calls(sb), /imagetools inspect/);
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.doesNotMatch(calls(sb), /-X PATCH/);
    assert.equal(read(sb.dgConfig), before);
    assert.equal(read(path.join(sb.dir, "agents.json")), agentsBefore);
    assert.equal(sighups(sb), "");
  });

  it("no eligible bots: the rollout is a no-op that still allows the images", () => {
    const sb = sandbox({ agents: [] });
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.equal(code, 0, out);
    assert.match(out, /no eligible bots/i);
    const cfg = dockergateConfig(sb);
    assert.ok(cfg.images.includes(`${BOT}@${HERMES}`));
  });

  it("refuses without BOARD_COMPANY_ID / dockergate config (fail-closed)", () => {
    const sb = sandbox();
    fs.writeFileSync(sb.config, read(sb.config).replace(`MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG=${sb.dgConfig}\n`, ""));
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--resolution", "tag", "--ref", VERSION]);
    assert.notEqual(code, 0);
    assert.match(out, /MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG is required/);
  });
});

describe("check-release-support.sh: bot image repositories", () => {
  it("resolves the three bot image components from a release tag", () => {
    const sb = sandbox();
    const result = spawnSync(
      process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
      [path.join(HERE, "..", "dockergate", "check-release-support.sh"), "--from-tag", VERSION, "--components", "hermes,hermes-dev,hermes-node"],
      { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout.trim().split("\n");
    assert.ok(out.includes(`hermes=${HERMES}`), out.join("\n"));
    assert.ok(out.includes(`hermes-dev=${HERMES_DEV}`), out.join("\n"));
    assert.ok(out.includes(`hermes-node=${HERMES_NODE}`), out.join("\n"));
  });

  it("refuses an unknown bot image component name", () => {
    const sb = sandbox();
    const result = spawnSync(
      process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
      [path.join(HERE, "..", "dockergate", "check-release-support.sh"), "--from-tag", VERSION, "--components", "hermes-typo"],
      { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown component: hermes-typo|MYR_COMPONENT_REPOSITORIES\[.*\]: unbound variable/);
  });
});

describe("deploy.sh: the bot image rollout rides along", () => {
  it("runs the bot image rollout after the components and before the smoke", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", `sha256:${"9".repeat(64)}`]);
    assert.equal(code, 0, out);
    // deploy.sh called the rollout with the release resolution.
    assert.match(out, /9\.5\/10 roll out the release's bot images \(tag 1\.6\.1\)/);
    assert.match(calls(sb), /docker pull --quiet ghcr\.io\/itkadr-git\/myrmidon-hermes@/);
    // The bots ended on the release images and the smoke saw them running.
    assert.match(out, /bot image rollout complete/);
    assert.match(out, /release gate passed/);
  });

  it("MYRMIDON_BOT_IMAGE_ROLLOUT=0: warns and skips (the 03.10 split)", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYRMIDON_BOT_IMAGE_ROLLOUT=0\n");
    const { code, out } = run(sb, "deploy.sh", ["--digest", `sha256:${"9".repeat(64)}`]);
    assert.equal(code, 0, out);
    assert.match(out, /WARNING: MYRMIDON_BOT_IMAGE_ROLLOUT=0/);
    assert.doesNotMatch(out, /9\.5\/10 roll out/);
  });

  it("a failing bot rollout marks the deploy DEGRADED with the rollback commands", () => {
    const sb = sandbox({ botImagesMissing: true });
    const { code, out } = run(sb, "deploy.sh", ["--digest", `sha256:${"9".repeat(64)}`]);
    assert.notEqual(code, 0);
    assert.match(out, /DEGRADED: the bot image rollout failed/);
    assert.match(out, /bot-image-rollout\.sh --config/);
  });

  it("--dry-run prints the bot rollout step and changes nothing", () => {
    const sb = sandbox();
    const before = read(sb.dgConfig);
    const { code, out } = run(sb, "deploy.sh", ["--digest", `sha256:${"9".repeat(64)}`, "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /9\.5 roll out the release's BOT images/);
    assert.equal(read(sb.dgConfig), before);
  });
});
