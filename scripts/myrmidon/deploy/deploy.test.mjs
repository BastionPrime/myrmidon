import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real deploy scripts against fake `docker`, `curl` and `git` placed
// first in PATH. The fakes log every call and answer from files in the sandbox;
// no test touches a real registry, remote or docker daemon.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  pull) exit "\${FAKE_PULL_EXIT:-0}" ;;
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

// Answers only what the image guard asks: clone location, origin URL, fetch,
// is-ancestor and the release tags of origin.
const FAKE_GIT = `#!/usr/bin/env bash
echo "git $*" >> "$SANDBOX/calls.log"
while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  rev-parse) [ -e "$SANDBOX/git-not-a-clone" ] && exit 128; echo "$SANDBOX/clone" ;;
  remote) cat "$SANDBOX/git-origin" ;;
  fetch) if [ -e "$SANDBOX/git-fetch-fails" ]; then echo "fatal: unable to access" >&2; exit 128; fi ;;
  merge-base) exit "$(cat "$SANDBOX/git-ancestor-exit")" ;;
  ls-remote) cat "$SANDBOX/git-tags" ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
cat "$SANDBOX/health.json"
`;

const VENDOR = "ghcr.io/paperclipai/paperclip:2026.916.1";

function sandbox({
  health,
  dumpBytes = 2048,
  labelVersion = VERSION,
  labelRevision = COMMIT,
  current = OLD,
  currentImage,
  // What the registry reports for the image (imagetools inspect): the labels, or null for none.
  registryLabels,
  registryMissing = false,
  origin = ORIGIN,
  notAClone = false,
  fetchFails = false,
  onMain = true,
  tags = "",
  noGit = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-deploy-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  if (!noGit) fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  const labels =
    registryLabels === undefined
      ? {
          "org.opencontainers.image.revision": labelRevision,
          "org.opencontainers.image.source": SOURCE,
          "org.opencontainers.image.version": labelVersion,
        }
      : registryLabels;
  fs.writeFileSync(
    path.join(dir, "imagetools.json"),
    JSON.stringify({ architecture: "amd64", os: "linux", config: { Env: ["A=1"], Labels: labels } }),
  );
  if (registryMissing) fs.writeFileSync(path.join(dir, "registry-missing"), "");
  fs.writeFileSync(path.join(dir, "git-origin"), `${origin}\n`);
  fs.writeFileSync(path.join(dir, "git-ancestor-exit"), onMain ? "0" : "1");
  fs.writeFileSync(path.join(dir, "git-tags"), tags);
  if (notAClone) fs.writeFileSync(path.join(dir, "git-not-a-clone"), "");
  if (fetchFails) fs.writeFileSync(path.join(dir, "git-fetch-fails"), "");
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
  return { dir, bin, config, override, noGit };
}

// A PATH with the tools the scripts need but without git.
function pathWithoutGit(sb) {
  const tools = path.join(sb.dir, "tools");
  fs.mkdirSync(tools, { recursive: true });
  for (const name of ["bash", "env", "dirname", "mktemp", "tail", "rm", "jq", "timeout", "cat", "grep", "sed", "head", "cut", "tr", "awk"]) {
    const found = process.env.PATH.split(":")
      .map((d) => path.join(d, name))
      .find((f) => fs.existsSync(f));
    if (found && !fs.existsSync(path.join(tools, name))) fs.symlinkSync(found, path.join(tools, name));
  }
  return `${sb.bin}:${tools}`;
}

function run(sb, script, args, input) {
  const searchPath = sb.noGit ? pathWithoutGit(sb) : `${sb.bin}:${process.env.PATH}`;
  const result = spawnSync(bashPath(), [path.join(HERE, script), "--config", sb.config, ...args], {
    env: { ...process.env, PATH: searchPath, SANDBOX: sb.dir },
    encoding: "utf8",
    input,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function bashPath() {
  return process.env.PATH.split(":")
    .map((d) => path.join(d, "bash"))
    .find((f) => fs.existsSync(f));
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
    assert.match(out, /image check passed/);
    assert.equal(read(sb.override), before);
    // Only the read-only image check ran: no pull, no compose.
    assert.match(calls(sb), /buildx imagetools inspect/);
    assert.doesNotMatch(calls(sb), /docker (pull|compose)/);
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

describe("deploy.sh: only CI images from the registry", () => {
  // Nothing may change before the check: no pull, dump, maintenance or compose.
  function assertNothingChanged(sb, before) {
    assert.equal(read(sb.override), before);
    assert.doesNotMatch(calls(sb), /docker (pull|compose)/);
    assert.equal(maintenance(sb), "");
    assert.ok(!fs.existsSync(path.join(sb.dir, "dumps")));
    assert.ok(!fs.existsSync(path.join(sb.dir, "state")));
  }

  function assertRefused(sb, args, pattern) {
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", args);
    assert.notEqual(code, 0, out);
    assert.match(out, pattern);
    assertNothingChanged(sb, before);
    return out;
  }

  describe("reference format", () => {
    const cases = [
      ["a bare tag", "1.0.2", /no digest/],
      ["latest", "latest", /no digest/],
      ["a tag reference without a digest", `${CI_IMAGE}:1.0.2`, /no digest .*tag/],
      ["the repository without a tag", CI_IMAGE, /no digest/],
      ["a tag together with a digest", `${CI_IMAGE}:1.0.2@${NEW}`, /is not ghcr\.io\/itkadr-git\/myrmidon/],
      ["another repository", `ghcr.io/example/other@${NEW}`, /only images built by CI/],
      ["another registry", `docker.io/itkadr-git/myrmidon@${NEW}`, /only images built by CI/],
      ["uppercase hex", `sha256:${"B".repeat(64)}`, /64 lowercase hex/],
      ["a short digest", "sha256:abc", /64 lowercase hex/],
      ["a short digest in a full reference", `${CI_IMAGE}@sha256:abc`, /64 lowercase hex/],
      ["a digest of another algorithm", `${CI_IMAGE}@sha512:${"b".repeat(64)}`, /64 lowercase hex/],
      ["an empty value", "", /no image given/],
    ];
    for (const [name, arg, pattern] of cases) {
      it(`refuses ${name} before any docker or git call`, () => {
        const sb = sandbox();
        assertRefused(sb, ["--digest", arg], pattern);
        assert.equal(calls(sb), "");
      });
    }

    it("refuses a missing --digest", () => {
      const sb = sandbox();
      const { code, out } = run(sb, "deploy.sh", []);
      assert.notEqual(code, 0);
      assert.match(out, /no image given/);
      assert.equal(calls(sb), "");
    });

    it("accepts the full reference of the CI image", () => {
      const sb = sandbox();
      const { code, out } = run(sb, "deploy.sh", ["--digest", `${CI_IMAGE}@${NEW}`]);
      assert.equal(code, 0, out);
      assert.match(out, /image ok: built by CI from commit 0123456789ab/);
      assert.match(read(sb.override), new RegExp(`image: ${CI_IMAGE}@${NEW}`));
    });

    it("refuses a settings file that points MYRMIDON_IMAGE at another repository", () => {
      const sb = sandbox();
      fs.appendFileSync(sb.config, "MYRMIDON_IMAGE=ghcr.io/example/other\n");
      assertRefused(sb, ["--digest", NEW], /MYRMIDON_IMAGE is 'ghcr\.io\/example\/other'/);
      assert.equal(calls(sb), "");
    });
  });

  describe("registry", () => {
    it("checks the image in the registry before the pull", () => {
      const sb = sandbox();
      const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
      assert.equal(code, 0, out);
      const log = calls(sb);
      assert.match(log, new RegExp(`docker buildx imagetools inspect ${CI_IMAGE}@${NEW}`));
      assert.ok(log.indexOf("imagetools inspect") < log.indexOf("docker pull"), log);
    });

    it("refuses an image that is not in the registry (a local build)", () => {
      const sb = sandbox({ registryMissing: true });
      const out = assertRefused(sb, ["--digest", NEW], /cannot be read from the registry.*not found/);
      assert.match(out, /image refused, nothing was changed/);
      assert.match(out, /cannot be skipped/);
    });

    it("refuses an image without the revision label", () => {
      const sb = sandbox({ registryLabels: { "org.opencontainers.image.version": VERSION, "org.opencontainers.image.source": SOURCE } });
      assertRefused(sb, ["--digest", NEW], /no org\.opencontainers\.image\.revision label/);
    });

    it("refuses an image with no labels at all", () => {
      const sb = sandbox({ registryLabels: null });
      assertRefused(sb, ["--digest", NEW], /no org\.opencontainers\.image\.revision label/);
    });

    it("refuses a revision label that is not a full commit sha", () => {
      const sb = sandbox({ registryLabels: { "org.opencontainers.image.revision": "efe4758", "org.opencontainers.image.source": SOURCE } });
      assertRefused(sb, ["--digest", NEW], /no org\.opencontainers\.image\.revision label with a full commit sha/);
    });

    it("refuses an image built from another repository", () => {
      const sb = sandbox({ registryLabels: { "org.opencontainers.image.revision": COMMIT, "org.opencontainers.image.source": "https://example.com/other/repo" } });
      assertRefused(sb, ["--digest", NEW], /image\.source 'https:\/\/example\.com\/other\/repo'/);
    });

    it("reads the labels of a per-platform map as well", () => {
      const sb = sandbox();
      fs.writeFileSync(
        path.join(sb.dir, "imagetools.json"),
        JSON.stringify({
          "linux/amd64": { config: { Labels: { "org.opencontainers.image.revision": COMMIT, "org.opencontainers.image.source": SOURCE } } },
        }),
      );
      const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
      assert.equal(code, 0, out);
    });
  });

  describe("commit of the image", () => {
    it("fetches main in the clone and accepts a commit reachable from origin/main", () => {
      const sb = sandbox();
      const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
      assert.equal(code, 0, out);
      assert.match(calls(sb), /git -C \S+ fetch --quiet --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
      assert.match(calls(sb), new RegExp(`git -C \\S+ merge-base --is-ancestor ${COMMIT} refs/remotes/origin/main`));
    });

    it("refuses a commit that is neither on main nor tagged", () => {
      const sb = sandbox({ onMain: false });
      assertRefused(sb, ["--digest", NEW], /neither on origin\/main nor tagged myr-v.*branch/);
    });

    it("accepts a commit that is not on main but carries an annotated myr-v tag", () => {
      const tags = `${"9".repeat(40)}\trefs/tags/myr-v1.0.0\n${COMMIT}\trefs/tags/myr-v1.0.0^{}\n`;
      const sb = sandbox({ onMain: false, tags });
      const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
      assert.equal(code, 0, out);
      assert.match(calls(sb), /git -C \S+ ls-remote --tags origin refs\/tags\/myr-v\*/);
    });

    it("accepts a commit that is not on main but carries a lightweight myr-v tag", () => {
      const sb = sandbox({ onMain: false, tags: `${COMMIT}\trefs/tags/myr-v1.2.3\n` });
      const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
      assert.equal(code, 0, out);
    });

    it("refuses when the myr-v tags point at other commits", () => {
      const sb = sandbox({ onMain: false, tags: `${"9".repeat(40)}\trefs/tags/myr-v1.0.0\n${"8".repeat(40)}\trefs/tags/myr-v1.0.0^{}\n` });
      assertRefused(sb, ["--digest", NEW], /neither on origin\/main nor tagged myr-v/);
    });

    it("refuses a tag that CI would not build (not myr-v<x>.<y>.<z>)", () => {
      const sb = sandbox({ onMain: false, tags: `${COMMIT}\trefs/tags/myr-v1.0.2-rc1\n${COMMIT}\trefs/tags/myr-vnext\n` });
      assertRefused(sb, ["--digest", NEW], /neither on origin\/main nor tagged myr-v/);
    });

    it("refuses when git is not installed", () => {
      const sb = sandbox({ noGit: true });
      const out = assertRefused(sb, ["--digest", NEW], /git is not installed/);
      assert.match(out, /0123456789ab/);
    });

    it("refuses when the scripts are not inside a git clone", () => {
      const sb = sandbox({ notAClone: true });
      assertRefused(sb, ["--digest", NEW], /not inside a git clone/);
    });

    it("refuses when origin is not the project repository", () => {
      const sb = sandbox({ origin: "https://github.com/example/fork.git" });
      const out = assertRefused(sb, ["--digest", NEW], /remote 'origin' .* does not point to github\.com\/itkadr-git\/myrmidon/);
      assert.doesNotMatch(out, /example\/fork/);
    });

    it("accepts the ssh form and a form with a user in the URL for origin", () => {
      for (const origin of ["git@github.com:itkadr-git/myrmidon.git", "https://ci-user:example@github.com/itkadr-git/myrmidon"]) {
        const sb = sandbox({ origin });
        const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
        assert.equal(code, 0, out);
      }
    });

    it("refuses when git fetch fails", () => {
      const sb = sandbox({ fetchFails: true });
      assertRefused(sb, ["--digest", NEW], /git fetch origin main failed/);
    });
  });

  describe("no way around it", () => {
    it("--force does not skip the check", () => {
      const sb = sandbox({ registryMissing: true });
      assertRefused(sb, ["--digest", NEW, "--force"], /cannot be read from the registry/);
    });

    it("--force does not skip the commit check either", () => {
      const sb = sandbox({ onMain: false });
      assertRefused(sb, ["--digest", NEW, "--force"], /neither on origin\/main nor tagged/);
    });

    it("has no flag that skips the check", () => {
      const sb = sandbox();
      for (const flag of ["--skip-image-check", "--no-verify", "--allow-local-image", "--insecure"]) {
        const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, flag]);
        assert.notEqual(code, 0);
        assert.match(out, /unknown argument/);
      }
      assert.equal(calls(sb), "");
    });

    it("--expect-version and --expect-commit do not skip it", () => {
      const sb = sandbox({ registryMissing: true });
      assertRefused(sb, ["--digest", NEW, "--expect-version", VERSION, "--expect-commit", COMMIT], /cannot be read from the registry/);
    });

    it("the dry run refuses too, and changes nothing", () => {
      const sb = sandbox({ registryMissing: true });
      assertRefused(sb, ["--digest", NEW, "--dry-run"], /cannot be read from the registry/);
    });

    it("the same digest that is already running is checked as well", () => {
      const sb = sandbox({ current: NEW, registryMissing: true });
      assertRefused(sb, ["--digest", NEW], /cannot be read from the registry/);
    });
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
    // The previous image is a CI image in the registry: nothing to warn about.
    assert.doesNotMatch(out, /WARNING/);
  });

  it("warns but still rolls back to an image built by hand (not in the registry)", () => {
    const sb = sandbox({ currentImage: "myrmidon-local:hotfix" });
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    assert.equal(read(path.join(sb.dir, "state/previous-image")).trim(), "myrmidon-local:hotfix");
    const { code, out } = run(sb, "rollback.sh", []);
    assert.equal(code, 0, out);
    assert.match(out, /WARNING: rollback target is not a verified CI image/);
    assert.match(read(sb.override), /image: myrmidon-local:hotfix\n/);
    assert.equal(maintenance(sb), "enter\nexit\nenter\nexit\n");
  });

  it("warns but does not block when the recorded previous digest is gone from the registry", () => {
    const sb = sandbox();
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    fs.writeFileSync(path.join(sb.dir, "registry-missing"), "");
    const { code, out } = run(sb, "rollback.sh", []);
    assert.equal(code, 0, out);
    assert.match(out, /WARNING: .*cannot be read from the registry/);
    assert.match(read(sb.override), new RegExp(`@${OLD}`));
  });

  it("warns, without blocking, when the previous image commit is not on main or a release tag", () => {
    const sb = sandbox({ onMain: false });
    fs.writeFileSync(path.join(sb.dir, "git-ancestor-exit"), "0");
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    fs.writeFileSync(path.join(sb.dir, "git-ancestor-exit"), "1");
    const { code, out } = run(sb, "rollback.sh", []);
    assert.equal(code, 0, out);
    assert.match(out, /WARNING: .*neither on origin\/main nor tagged myr-v/);
  });

  it("returns to a vendor image after the first deploy from it", () => {
    const sb = sandbox({ currentImage: VENDOR });
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    assert.equal(read(path.join(sb.dir, "state/previous-image")).trim(), VENDOR);
    const { code, out } = run(sb, "rollback.sh", []);
    assert.equal(code, 0, out);
    assert.match(read(sb.override), new RegExp(`image: ${VENDOR.replace(/[.]/g, "\\.")}\\n`));
    assert.match(out, /WARNING: rollback target is not a verified CI image/);
    assert.match(out, /emergency path/);
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
