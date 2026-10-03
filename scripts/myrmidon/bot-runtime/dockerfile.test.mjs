import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Guards for docker/bot-runtime (G1): the image must run as a non-root
// user, ship a HEALTHCHECK, use tini as PID 1, and never carry media
// tools — CONVENTIONS.md §8 forbids them in any Myrmidon image.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGE_DIR = path.join(ROOT, "docker/bot-runtime");
const dockerfile = fs.readFileSync(path.join(IMAGE_DIR, "Dockerfile"), "utf8");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/myrmidon-bot-image.yml"), "utf8");

// The Dockerfile documents, in a comment, that it deliberately does not
// install media tools — so "no media tools" is checked against the
// instructions only, not comment prose explaining that absence.
// The Node.js variant is a separate final stage (`runtime-node`, checked below);
// the default image, i.e. everything before it, must stay node-free.
const variantStart = dockerfile.indexOf("FROM python:3.13-slim AS node_dist");
assert.ok(variantStart > 0, "Dockerfile must define the node_dist stage of the Node.js variant");
// The development variant (runtime-dev) is a third final stage. The Node.js
// variant test must stop before it: the dev stage legitimately runs as root
// while it installs toolchains, which the Node.js variant must never do.
const devVariantStart = dockerfile.indexOf("FROM python:3.13-slim AS node24_dist");
assert.ok(devVariantStart > 0, "Dockerfile must define the node24_dist stage of the development variant");
assert.ok(devVariantStart > variantStart, "the development variant must follow the Node.js variant stages");
const dockerfileInstructions = dockerfile
  .slice(0, variantStart)
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

// The roots come from the dockergate policy itself, so the test and the policy
// cannot drift apart.
const policySource = fs.readFileSync(path.join(ROOT, "tools/dockergate/internal/policy/image.go"), "utf8");
const unsafeRootsMatch = policySource.match(/var unsafeRoots = \[\]string\{([^}]*)\}/);
const unsafeRoots = unsafeRootsMatch ? [...unsafeRootsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

describe("docker/bot-runtime/Dockerfile", () => {
  it("keeps every writable volume out of PATH in every stage (dockergate image check)", () => {
    assert.ok(unsafeRoots.length >= 4, "unsafeRoots must be read from the dockergate policy");
    for (const root of ["/data", "/workspace", "/scratch", "/tmp"]) {
      assert.ok(unsafeRoots.includes(root), `dockergate policy no longer lists ${root}`);
    }
    // Join line continuations, then look at every ENV instruction's PATH value.
    const joined = dockerfile.replace(/\\\n/g, " ");
    const values = [];
    for (const line of joined.split("\n")) {
      if (!/^\s*ENV\s/.test(line)) continue;
      for (const m of line.matchAll(/(?:^|\s)PATH=(\S+)/g)) values.push(m[1]);
    }
    assert.ok(values.length >= 2, "expected PATH to be set in the runtime and runtime-node stages");
    for (const value of values) {
      for (const el of value.split(":")) {
        for (const root of unsafeRoots) {
          assert.ok(el !== root && !el.startsWith(`${root}/`), `PATH element ${el} is under writable root ${root}`);
        }
      }
    }
  });

  it("pins the hermes version and a matching git tag through build args with exact defaults", () => {
    // hermes-agent's git tags (vYYYY.M.D, calendar-based) and its
    // pyproject.toml `version` field (0.x.y, bumped independently) do not
    // share a numbering scheme — see the ARG block's comment. Only check
    // that both are pinned to something exact, not that they look alike.
    assert.match(dockerfile, /^ARG HERMES_VERSION=\d+\.\d+\.\d+$/m);
    assert.match(dockerfile, /^ARG HERMES_GIT_REF=v\d+\.\d+(\.\d+)?$/m);
  });

  it("pins the exact commit the git tag must resolve to, and checks it before .git is removed", () => {
    // A git tag is a mutable ref (moved tag, upstream force-push, MITM on the
    // clone) — HERMES_GIT_SHA is the thing that actually pins the tree.
    assert.match(dockerfile, /^ARG HERMES_GIT_SHA=[0-9a-f]{40}$/m);
    const gitCloneIdx = dockerfile.indexOf("git clone");
    const gitHistoryRemovalIdx = dockerfile.search(/rm -rf[^\n]*\/opt\/hermes-src\/\.git\b/);
    const shaCheckIdx = dockerfile.indexOf('"$actual" != "${HERMES_GIT_SHA}"');
    assert.ok(gitCloneIdx > 0 && shaCheckIdx > gitCloneIdx,
      "expected the SHA check after the clone");
    assert.ok(gitHistoryRemovalIdx > 0 && shaCheckIdx < gitHistoryRemovalIdx,
      "expected the SHA check strictly before .git is removed — otherwise there is nothing left to check against");
  });

  it("runs as a non-root, fixed uid", () => {
    assert.match(dockerfile, /USER 10001:10001/);
    // The development variant (see below) is the one stage that switches to root
    // to install its toolchains, and it returns to the contract user before it
    // ends. Every other stage — and the finished dev image — runs as 10001:10001.
    const beforeDevVariant = dockerfile.slice(0, dockerfile.indexOf("Variant `runtime-dev`"));
    assert.ok(beforeDevVariant.length > 0, "expected the runtime/node stages before the development variant");
    assert.doesNotMatch(beforeDevVariant, /^USER root$/m);
    assert.doesNotMatch(dockerfile, /^USER 0(:0)?$/m);
  });

  it("uses tini as PID 1", () => {
    assert.match(dockerfile, /tini/);
    assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "--",/m);
  });

  it("installs the ssh client without recommended packages", () => {
    assert.match(dockerfileInstructions, /--no-install-recommends[\s\S]*?\bopenssh-client\b/);
  });

  it("installs jq in the runtime stage without recommended packages", () => {
    assert.match(dockerfileInstructions, /--no-install-recommends[\s\S]*?\bjq\b/);
  });

  it("declares a HEALTHCHECK against a real gateway endpoint", () => {
    assert.match(dockerfile, /^HEALTHCHECK /m);
    // gateway/platforms/api_server.py: GET /health needs no auth; GET
    // /v1/capabilities is Bearer-gated. Either is a "real" endpoint — just
    // make sure it's not pointing at something made up.
    assert.match(dockerfile, /\/health\b|\/v1\/capabilities\b/);
  });

  it("exposes the gateway API server port", () => {
    assert.match(dockerfile, /^EXPOSE 8642$/m);
  });

  it("declares volumes for state, workspace and scratch, not a host bind", () => {
    // The three mounts the bot-runtime contract fixes (template.ts
    // BOT_VOLUME_MOUNTS): hermes (under /data), workspace, scratch.
    assert.match(dockerfile, /^VOLUME \["\/data", "\/workspace", "\/scratch"\]$/m);
  });

  it("declares the bot-runtime contract label the G3 driver requires before it will create a container", () => {
    assert.match(dockerfile, /myrmidon\.bot-runtime\.contract="1"/);
  });

  it("carries no media tools or Docker socket access", () => {
    assert.doesNotMatch(dockerfileInstructions, /\b(ffmpeg|ffprobe|yt-dlp|youtube-dl)\b/i);
    assert.doesNotMatch(dockerfileInstructions, /docker\.sock/);
  });

  it("does not install hermes-agent from PyPI (unsupported at this release)", () => {
    assert.doesNotMatch(dockerfileInstructions, /pip install[^\n]*hermes-agent/);
  });

  it("installs aiohttp through the locked lockfile path, not an unlocked pip install", () => {
    // tools/lazy_deps.py's own hash-pinned allowlist is the bar every
    // dependency in this image should clear; a bare `uv pip install
    // aiohttp==...` bypasses uv.lock's hash verification even though the
    // exact same pin already exists there.
    assert.doesNotMatch(dockerfileInstructions, /uv pip install[^\n]*aiohttp/);
    assert.match(dockerfile, /uv sync --frozen --extra sms --extra mcp --python/);
    // The "hindsight" extra is gone from hermes 0.21.5 (the provider moved to the plugin
    // catalog) — requesting it would silently resolve to nothing.
    assert.doesNotMatch(dockerfile, /--extra hindsight/);
  });

  it("bakes in mcp, and vendors the Hindsight provider from hermes' plugin catalog", () => {
    assert.match(dockerfile, /--extra mcp\b/);
    // The provider is not a python extra any more: the builder clones the exact commit the
    // bundled catalog entry names, verifies it, and the plugin's own declared dependencies
    // are installed through hermes' plugin installer (never a bare `uv pip install`).
    assert.match(dockerfile, /plugin-catalog\/hindsight\.yaml/);
    assert.match(dockerfile, /install_for_plugin_dir/);
    assert.match(dockerfile, /git -C \/tmp\/hindsight-plugin rev-parse HEAD/);
    // And actually checked, not just requested.
    assert.match(dockerfile, /import aiohttp, mcp, hindsight_client/);
    assert.match(dockerfile, /find_provider_dir\('hindsight'\)/);
    // Sealed copy in /opt, linked into the writable HERMES_HOME by the entrypoint.
    assert.match(dockerfile, /^COPY --from=builder --chown=root:root \/opt\/hermes-plugins \/opt\/hermes-plugins$/m);
    const entrypoint = fs.readFileSync(path.join(IMAGE_DIR, "entrypoint.sh"), "utf8");
    assert.match(entrypoint, /ln -s "\$\{catalog_dir\}\/hindsight"/);
  });

  it("import-smokes every module a patch changes, so a patch that applies but breaks a module fails the build", () => {
    // `git apply` only proves the hunks land. The smoke must name one module per patched
    // file: 04 hermes_state, 02 the two session-environment files, 05 gateway.run.
    const smoke = dockerfileInstructions.match(/^RUN [^\n]*python -c 'import (hermes_state[^']*)'$/m);
    assert.ok(smoke, "expected a build-time import smoke that starts with hermes_state");
    const modules = smoke[1].split(",").map((m) => m.trim());
    for (const module of [
      "hermes_state",
      "tools.environments.base",
      "tools.environments.base_session_env",
      "gateway.run",
      "gateway.platforms.api_server_runs",
      "tools.environments.local",
      "tools.github_broker_context",
    ]) {
      assert.ok(modules.includes(module), `import smoke must include ${module}`);
    }
    // It runs after the venv is synced (the patched tree is what gets imported) and before
    // the runtime stage copies the tree.
    const syncIdx = dockerfileInstructions.indexOf("uv sync --frozen");
    const smokeIdx = dockerfileInstructions.indexOf(smoke[0]);
    const runtimeIdx = dockerfileInstructions.indexOf("FROM python:3.13-slim AS runtime");
    assert.ok(syncIdx > 0 && smokeIdx > syncIdx, "expected the import smoke after uv sync");
    assert.ok(runtimeIdx > smokeIdx, "expected the import smoke in the builder stage");
  });

  it("runs the state-db descriptor-probe regression against the patched tree at build time", () => {
    // Patch 06 bounds the /proc/self/fd generation probe on the write path. The import
    // smoke only proves the patched module still imports; the behaviour check has to run
    // too, against the same synced venv and the same patched tree, and the file it runs
    // must ship in the build context.
    const run = dockerfileInstructions.match(/^RUN [^\n]*\/tmp\/patch-tests\/(\S+\.py)\s+\/opt\/hermes-src$/m);
    assert.ok(run, "expected a build-time run of a docker/bot-runtime/tests regression");
    assert.ok(
      fs.existsSync(path.join(IMAGE_DIR, "tests", run[1])),
      `docker/bot-runtime/tests/${run[1]} must exist`,
    );
    // myrmidon(G1): every patch with a behaviour regression gets its own
    // build-time run; 09-run-scoped-github-broker has
    // github_broker_run_scope.py (contextvar binding + child-env bridge).
    const patchTestRuns = [...dockerfileInstructions.matchAll(/^RUN [^\n]*\/tmp\/patch-tests\/(\S+\.py)\s+\/opt\/hermes-src$/gm)].map((m) => m[1]);
    for (const regression of ["state_db_fd_probe_budget.py", "github_broker_run_scope.py"]) {
      assert.ok(
        patchTestRuns.includes(regression),
        `expected a build-time run of docker/bot-runtime/tests/${regression}`,
      );
      assert.ok(
        fs.existsSync(path.join(IMAGE_DIR, "tests", regression)),
        `docker/bot-runtime/tests/${regression} must exist`,
      );
    }
    assert.match(dockerfile, /^COPY tests\/ \/tmp\/patch-tests\/$/m);
    const syncIdx = dockerfileInstructions.indexOf("uv sync --frozen");
    const runIdx = dockerfileInstructions.indexOf(run[0]);
    const runtimeIdx = dockerfileInstructions.indexOf("FROM python:3.13-slim AS runtime");
    assert.ok(runIdx > syncIdx, "expected the regression run after uv sync");
    assert.ok(runtimeIdx > runIdx, "expected the regression run in the builder stage");
    // The builder stage's test copy must not reach the runtime image. Index into the raw
    // Dockerfile here: the instruction list above has its comment lines stripped, so its
    // offsets do not address the file it came from.
    assert.doesNotMatch(dockerfile.slice(dockerfile.indexOf("FROM python:3.13-slim AS runtime")), /patch-tests/);
  });

  it("redirects hermes' lazy installs and write tools off the sealed, read-only venv", () => {
    // Sealing /opt/hermes-src read-only (below) otherwise leaves
    // tools/lazy_deps.py trying to install into it and
    // agent/file_safety.py's write guard inert — see the comment above the
    // ENV block and README.md "Sealed image: lazy installs and the
    // write-safe root".
    assert.match(dockerfile, /HERMES_DISABLE_LAZY_INSTALLS=1/);
    assert.match(dockerfile, /HERMES_LAZY_INSTALL_TARGET=\/data\//);
    assert.match(dockerfile, /HERMES_WRITE_SAFE_ROOT=\/data[^\n"]*\/scratch/);
  });

  it("ships uv in the runtime stage too, so a still-permitted lazy install (an opt-in backend) actually works", () => {
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM python:3.13-slim AS runtime"));
    assert.match(runtimeStage, /^COPY --chmod=0755 --from=uv_bin \/usr\/local\/bin\/uv \/usr\/local\/bin\/uvx/m);
  });

  it("points HOME at a writable, mounted path, not the read-only rootfs", () => {
    // ReadonlyRootfs: true (docker-driver.ts) makes anything under the image's
    // own /home/<user> unwritable at runtime.
    assert.doesNotMatch(dockerfile, /HOME=\/home\/bot/);
    assert.match(dockerfile, /HOME=\/data\/hermes/);
  });

  it("strips the clone's .git history before the runtime stage copies /opt/hermes-src", () => {
    const builderStageEnd = dockerfile.indexOf("FROM python:3.13-slim AS runtime");
    assert.ok(builderStageEnd > 0, "expected a runtime stage after the builder stage");
    // The removal must happen in the builder stage (i.e. before this index),
    // strictly before the runtime stage's COPY --from=builder picks the
    // directory up — otherwise .git ships in the final image.
    const builderStage = dockerfile.slice(0, builderStageEnd);
    assert.match(builderStage, /rm -rf[^\n]*\/opt\/hermes-src\/\.git\b/);
    const runtimeStage = dockerfile.slice(builderStageEnd);
    assert.match(runtimeStage, /^COPY --from=builder[^\n]*\/opt\/hermes-src[^\n]*$/m);
  });
});

describe("docker/bot-runtime/patches/", () => {
  it("has a README documenting the patch mechanism", () => {
    assert.ok(fs.existsSync(path.join(IMAGE_DIR, "patches/README.md")));
  });

  it("ships the session-snapshot secret-redaction, state-read and gateway-executor patches", () => {
    const patchesDir = path.join(IMAGE_DIR, "patches");
    const files = fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch"));
    assert.ok(files.some((f) => f.includes("secret")), "expected a session-snapshot secret-redaction patch");
    assert.ok(files.some((f) => f.includes("state-read")), "expected a state-read retry patch");
    assert.ok(files.some((f) => f.includes("gateway-executor")), "expected a gateway executor pool patch");
    assert.ok(files.some((f) => f.includes("fd-probe")), "expected a state-db descriptor-probe patch");
    // The two hindsight patches are gone on purpose: v2026.9.24 removed the in-tree provider
    // (the plugin catalog owns it now) and the catalog plugin already carries the retain_async
    // fix. A stray hindsight patch would fail `git apply` at build time.
    assert.ok(!files.some((f) => f.includes("hindsight")), "no hindsight patch may remain: the provider left the tree");
    for (const file of files) {
      const patch = fs.readFileSync(path.join(patchesDir, file), "utf8");
      // CONVENTIONS.md §9/§10: no internal ticket numbers or company-specific names
      // in a patch that lands in the open repository.
      assert.doesNotMatch(patch, /\bOPE-\d+\b/, `${file} must not carry an internal ticket number`);
      // Comments in code are English (CONVENTIONS.md §8); a Cyrillic comment means a
      // reference-checkout patch was copied instead of rewritten.
      assert.doesNotMatch(patch, /[\u0400-\u04FF]/, `${file} must be written in English`);
      // Every edit to hermes code carries the fork label (CONVENTIONS.md §8).
      assert.match(patch, /myrmidon\(G1\)/, `${file} must carry the myrmidon(G1) label`);
    }
  });

  it("orders the patches by their two-digit prefix, one number each", () => {
    // The Dockerfile applies patches in sorted filename order; a duplicated or
    // unnumbered prefix would make the order accidental.
    const files = fs.readdirSync(path.join(IMAGE_DIR, "patches")).filter((f) => f.endsWith(".patch"));
    const numbers = files.map((f) => f.match(/^(\d\d)-/)?.[1]);
    assert.ok(numbers.every((n) => n !== undefined), `every patch needs an NN- prefix: ${files.join(", ")}`);
    assert.equal(new Set(numbers).size, numbers.length, "patch numbers must be unique");
  });

  it("retries a state-database read that finds the database locked, with fixed bounds", () => {
    // Two concurrent runs of one agent (a writer and a session-history reader) made the
    // reader fail with "database is locked": the read path replayed only "disk I/O error".
    const patch = fs.readFileSync(
      path.join(IMAGE_DIR, "patches/04-state-read-retry-when-locked.patch"),
      "utf8",
    );
    assert.match(patch, /^\+\+\+ b\/hermes_state\.py$/m);
    assert.match(patch, /^\+_READ_LOCKED_MARKERS = \("database is locked", "database is busy"\)$/m);
    assert.match(patch, /^\+_READ_LOCKED_RETRY_ATTEMPTS = 15$/m);
    assert.match(patch, /^\+_READ_LOCKED_RETRY_CAP_S = 1\.0$/m);
    // The wait is jittered and bounded, the disk-I/O-error budget is untouched, and any
    // other OperationalError is still raised at once.
    assert.match(patch, /^\+.*\(0\.5 \+ random\.random\(\)\)/m);
    assert.match(patch, /^\+.*_DISK_IO_ERROR_MARKER not in err/m);
    assert.match(patch, /^\+.*raise$/m);
    // No new environment knobs: every such variable would need its own documented setting.
    assert.doesNotMatch(patch, /^\+.*os\.environ/m);
  });

  it("sizes the gateway's default executor pool, overridable by one documented variable", () => {
    // With the stock asyncio pool every live run holds one worker for its whole life, so
    // create calls on the board's hermes_gateway adapter timed out behind them.
    const patch = fs.readFileSync(
      path.join(IMAGE_DIR, "patches/05-gateway-executor-pool.patch"),
      "utf8",
    );
    assert.match(patch, /^\+\+\+ b\/gateway\/run\.py$/m);
    assert.match(patch, /^\+.*set_default_executor\(/m);
    assert.match(patch, /^\+.*max_workers=int\(os\.environ\.get\("HERMES_GATEWAY_EXECUTOR_WORKERS", "64"\)\)/m);
    // It must be the first thing start_gateway does — anything before it could already have
    // queued work onto the stock pool.
    assert.match(patch, /^@@ -\d+,\d+ \+5796,\d+ @@/m);
  });

  it("documents every patch in patches/README.md and closes the reference-checkout gap", () => {
    const patchesDir = path.join(IMAGE_DIR, "patches");
    const readme = fs.readFileSync(path.join(patchesDir, "README.md"), "utf8");
    const mainReadme = fs.readFileSync(path.join(IMAGE_DIR, "README.md"), "utf8");
    for (const file of fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch"))) {
      assert.ok(readme.includes(`\`${file}\``), `patches/README.md must list ${file}`);
    }
    // A tree diff of the reference checkout against the pinned tag gives a closed list of
    // files; the README decides every one of them (ported, or not needed and why).
    for (const file of [
      "hermes_state.py",
      "agent/chat_completion_helpers.py",
      "cli.py",
      "tools/browser_tool.py",
      "tools/browser_tool_session.py",
      "plugins/memory/hindsight/README.md",
    ]) {
      assert.ok(readme.includes(`\`${file}\``), `patches/README.md must decide ${file}`);
    }
    // The old text called the remainder an open gap that needs the full history; it is a
    // closed list obtained by a plain tree diff.
    for (const text of [readme, mainReadme]) {
      assert.doesNotMatch(text, /not yet\*\* ported/i);
      assert.doesNotMatch(text, /known gap/i);
      assert.doesNotMatch(text, /full (local )?history/i);
      assert.doesNotMatch(text, /full access to that checkout/i);
    }
  });

  it("ships no browser, which is why the browser-tool socket patches are not carried", () => {
    // patches/README.md leaves tools/browser_tool*.py unported because the image has no
    // agent-browser CLI, Node or Chromium. If a browser is ever added, this fails: port
    // those two files together with it. Neither the Node.js variant nor the development
    // variant is a browser, and neither may carry one: the check below reaches both of
    // them, and the main image (checked against `dockerfileInstructions`, which stops at
    // the first variant stage) still ships no Node at all.
    assert.doesNotMatch(dockerfileInstructions, /chromium|playwright|agent-browser|nodejs|\bnpm\b|\bnpx\b/i);
    const variants = dockerfile.slice(variantStart).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(variants, /chromium|playwright|agent-browser|puppeteer/i);
  });

  it("keeps the Node.js variant a stage on top of runtime, with the same user, label and no media tools", () => {
    assert.match(dockerfile, /^FROM runtime AS runtime-node$/m);
    // Slice only the Node.js variant: up to the development variant's banner
    // comment that follows it. Comment lines are dropped so prose (the dev
    // stage's banner explains that it inherits the contract label) cannot
    // satisfy or trip a shape assertion.
    const nodeVariantRaw = dockerfile.slice(
      dockerfile.indexOf("FROM runtime AS runtime-node"),
      dockerfile.indexOf("Variant `runtime-dev`"),
    );
    assert.ok(nodeVariantRaw.length > 0, "expected the Node.js variant before the development variant");
    const variant = nodeVariantRaw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.match(variant, /^USER 10001:10001$/m);
    assert.doesNotMatch(variant, /^USER (root|0)/m);
    assert.doesNotMatch(variant, /ffmpeg|yt-dlp|imagemagick|libreoffice|tesseract/i);
    // The contract label is inherited from `runtime`; the variant only adds a marker.
    assert.match(variant, /io\.github\.itkadr-git\.myrmidon\.variant="node"/);
    assert.doesNotMatch(variant, /myrmidon\.bot-runtime\.contract=/);
    // Build-time check as the runtime user, and no ENTRYPOINT/HEALTHCHECK override.
    assert.match(variant, /^RUN node \/opt\/node-tools\/smoke\.cjs/m);
    assert.doesNotMatch(variant, /^(ENTRYPOINT|HEALTHCHECK|CMD) /m);
  });

  it("pins the Node.js tarball by exact version and sha256, and writable paths point at volumes", () => {
    assert.match(dockerfile, /^ARG NODE_VERSION=22\.\d+\.\d+$/m);
    assert.match(dockerfile, /^ARG NODE_SHA256=[0-9a-f]{64}$/m);
    assert.match(dockerfile, /sha256sum -c -/);
    assert.match(dockerfile, /NPM_CONFIG_CACHE=\/scratch\//);
    assert.match(dockerfile, /NPM_CONFIG_PREFIX=\/scratch\//);
  });

  it("installs only exactly pinned packages, from a lockfile", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(IMAGE_DIR, "node-tools/package.json"), "utf8"));
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version`);
    }
    assert.ok(fs.existsSync(path.join(IMAGE_DIR, "node-tools/package-lock.json")));
    assert.match(dockerfile, /npm ci --omit=dev/);
  });
});

// The development variant (`runtime-dev`, image myrmidon-hermes-dev): the same
// runtime guarantees plus the toolchain a member of the development team needs
// to run a repository pull-request cycle (install, typecheck, test, push) from
// inside a bot container.
describe("docker/bot-runtime/Dockerfile (development variant)", () => {
  // Everything from the first stage that belongs to the development variant
  // (the helper download stages plus the `runtime-dev` stage itself). Used for
  // cross-stage assertions such as "every download is pinned".
  const devVariant = dockerfile.slice(dockerfile.indexOf("FROM python:3.13-slim AS node24_dist"));
  const devInstructions = devVariant.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  // Only the final stage, for assertions about what the finished image is
  // (user, label, PATH, the toolchain check) — the helper stages are throwaway
  // builders that never reach the published image.
  const devStage = dockerfile.slice(dockerfile.indexOf("FROM runtime AS runtime-dev"));
  assert.ok(devStage.length > 0, "Dockerfile must define the runtime-dev stage");
  const devStageInstructions = devStage.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("is a stage on top of runtime that ends as the contract user and keeps the variant marker", () => {
    assert.match(dockerfile, /^FROM runtime AS runtime-dev$/m);
    // The contract user is restored before the stage ends — root is only used to install.
    const afterUser = devStageInstructions.slice(devStageInstructions.lastIndexOf("USER 10001:10001"));
    assert.ok(afterUser.length > 0, "the dev variant must return to USER 10001:10001");
    assert.match(devStageInstructions, /^USER root$/m);
    // The contract label is inherited from `runtime`; the variant only adds a marker.
    assert.match(devStageInstructions, /io\.github\.itkadr-git\.myrmidon\.variant="dev"/);
    assert.doesNotMatch(devStageInstructions, /myrmidon\.bot-runtime\.contract=/);
    // No ENTRYPOINT/HEALTHCHECK/CMD override: the gateway entrypoint is inherited.
    assert.doesNotMatch(devStageInstructions, /^(ENTRYPOINT|HEALTHCHECK|CMD) /m);
  });

  it("installs exactly the toolchain the pull-request cycle needs", () => {
    // Read the apt list of the final stage itself rather than the whole variant:
    // a bare substring match would also hit the prose, the Rust installer and the
    // helper stages' own apt lists.
    const aptBlock = devStage.match(/apt-get install -y --no-install-recommends([\s\S]*?)&& rm -rf/)?.[1] ?? "";
    for (const tool of [
      "bash",
      "ca-certificates",
      "curl",
      "g++",
      "gcc",
      "gh",
      "git",
      "jq",
      "libc6-dev",
      "make",
      "openssh-client",
      "pkg-config",
      "python3",
      "ripgrep",
      "unzip",
      "xz-utils",
      "zstd",
    ]) {
      const expected = new RegExp(`(^|\\s)${tool.replace(/\+/g, "\\+")}(\\s|$)`);
      assert.match(aptBlock, expected, `the dev variant must install ${tool}`);
    }
    assert.match(devStage, /^ARG PNPM_VERSION=9\.15\.4$/m);
    assert.match(devVariant, /^ARG NODE24_VERSION=24\.\d+\.\d+$/m);
    assert.match(devVariant, /^ARG GO_VERSION=1\.25\.\d+$/m);
    assert.match(devVariant, /^ARG DOCKER_CLI_VERSION=29\.\d+\.\d+$/m);
  });

  it("pins every downloaded toolchain by exact version and sha256, checked before use", () => {
    assert.match(devVariant, /^ARG NODE24_SHA256=[0-9a-f]{64}$/m);
    assert.match(devVariant, /^ARG GO_SHA256=[0-9a-f]{64}$/m);
    assert.match(devVariant, /^ARG RUSTUP_SHA256_AMD64=[0-9a-f]{64}$/m);
    assert.match(devVariant, /^ARG DOCKER_CLI_SHA256=[0-9a-f]{64}$/m);
    // Four downloads in the variant: Node.js 24, Go, the Docker CLI tarball and
    // rustup — each with its own digest check.
    assert.equal(devVariant.match(/sha256sum -c -/g)?.length, 4);
    // The pnpm version is verified in the image it was installed into.
    assert.match(devStage, /pnpm --version \| grep -x "\$\{PNPM_VERSION\}"/);
  });

  it("carries the Docker CLI client only, never an engine", () => {
    // The bot container runs no engine: dockerd is the sandbox VM's, reached over
    // mutual TLS. Dragging an engine in would contradict the whole design, so the
    // helper stage copies exactly one binary out of the release tarball.
    assert.match(devVariant, /cp \/tmp\/docker-cli\/docker\/docker \/opt\/docker-cli\/bin\/docker/);
    for (const engineBin of ["dockerd", "containerd", "runc", "docker-proxy", "dockerd-rootless.sh"]) {
      assert.ok(
        !new RegExp(`/opt/docker-cli/bin/${engineBin}\\b`).test(devVariant),
        `the Docker helper stage must not install ${engineBin}`,
      );
    }
    // No engine binary name is COPYed into the final stage either.
    assert.doesNotMatch(devStageInstructions, /\bdockerd\b|\bcontainerd\b|\brunc\b/);
  });

  it("keeps the Rust channel in step with the package that owns the pin", () => {
    // packages/paperclip-runner/rust-toolchain.toml is the single owner of the
    // compiler pin (the repository's own build Dockerfile takes it from there).
    const toolchain = fs.readFileSync(path.join(ROOT, "packages/paperclip-runner/rust-toolchain.toml"), "utf8");
    const channel = toolchain.match(/^channel\s*=\s*"([^"]+)"$/m)?.[1];
    assert.ok(channel, "rust-toolchain.toml must pin a channel");
    assert.match(devVariant, new RegExp(`^ARG RUST_CHANNEL=${channel.replace(/\./g, "\\.")}$`, "m"));
  });

  it("keeps every PATH element out of a writable root (dockergate image check)", () => {
    // PATH is assembled from /opt and /usr only, and never holds /data,
    // /workspace, /scratch or /tmp — dockergate refuses the image otherwise.
    // Join line continuations first (the same way the main-image test does),
    // then take the last PATH value, which is the one the finished stage keeps.
    const joined = devStageInstructions.replace(/\\\n/g, " ");
    const values = [...joined.matchAll(/(?:^|\s)PATH=([^\s"']+)/g)].map((m) => m[1]);
    assert.ok(values.length >= 1, "the dev variant must set PATH explicitly");
    const path = values[values.length - 1];
    for (const el of path.split(":")) {
      for (const root of ["/data", "/workspace", "/scratch", "/tmp"]) {
        assert.ok(el !== root && !el.startsWith(`${root}/`), `PATH element ${el} is under writable root ${root}`);
      }
    }
    for (const tool of ["/opt/node24/bin", "/opt/pnpm/bin", "/opt/go/bin", "/opt/cargo/bin", "/opt/docker-cli/bin"]) {
      assert.ok(path.split(":").includes(tool), `PATH must contain ${tool}`);
    }
    // The pnpm store is redirected to the durable volume, not the read-only image.
    assert.match(devStageInstructions, /npm_config_store_dir=\/data\/hermes\//);
  });

  it("sets no shell-start variable, which dockergate also refuses", () => {
    // image.go denies an image that carries ENV or BASH_ENV (a shell that reads a
    // file at start). The dev variant must not introduce either.
    assert.doesNotMatch(devStageInstructions, /^\s*ENV\s+[^\n]*\b(ENV|BASH_ENV)=/m);
    assert.doesNotMatch(devStageInstructions, /\bBASH_ENV\b/);
  });

  it("checks every toolchain as the contract user in the finished stage", () => {
    const check = devStageInstructions.slice(devStageInstructions.lastIndexOf("USER 10001:10001"));
    for (const tool of ["node --version", "pnpm --version", "go version", "cargo --version", "rustc --version", "gh --version", "jq --version", "zstd --version", "docker --version"]) {
      assert.ok(check.includes(tool), `the dev image's build-time check must run ${tool}`);
    }
  });
});

describe("myrmidon-bot-image.yml", () => {
  it("publishes to the dedicated bot-image namespace", () => {
    assert.match(workflow, /IMAGE: ghcr\.io\/itkadr-git\/myrmidon-hermes\n/);
  });

  it("builds the default image with an explicit target and the Node.js variant as its own image with the same gating", () => {
    assert.equal(workflow.match(/target: runtime\n/g)?.length, 2);
    assert.equal(workflow.match(/target: runtime-node\n/g)?.length, 2);
    assert.match(workflow, /IMAGE: ghcr\.io\/itkadr-git\/myrmidon-hermes-node\n/);
    const nodeJob = workflow.slice(workflow.indexOf("  build-node:"));
    assert.match(nodeJob, /if: \$\{\{ github\.repository == 'itkadr-git\/myrmidon' \}\}/);
    assert.equal(nodeJob.match(/if: \$\{\{ github\.event_name != 'pull_request' \}\}/g)?.length >= 4, true);
    assert.match(nodeJob, /--read-only --user 10001:10001/);
    assert.match(nodeJob, /require\(m\)/);
  });

  it("only in this repository, and pushes only outside pull_request", () => {
    assert.match(workflow, /if: \$\{\{ github\.repository == 'itkadr-git\/myrmidon' \}\}/);
    assert.match(workflow, /if: \$\{\{ github\.event_name != 'pull_request' \}\}/);
    assert.match(workflow, /push: false/);
  });

  it("checks the built image's own bot-runtime contract label on pull requests, without pushing it", () => {
    // The pull-request build is loaded locally (never pushed) so the finished image's
    // metadata can be inspected — the `labels:` input is merged with the Dockerfile's
    // LABELs, and only the built image shows what the G3 driver would actually see.
    assert.match(workflow, /tags: myrmidon-hermes:pr-check\n\s+push: false\n\s+load: true/);
    assert.match(workflow, /docker image inspect[^\n]*myrmidon\.bot-runtime\.contract[^\n]*myrmidon-hermes:pr-check/);
    assert.match(workflow, /docker run --rm --entrypoint uv myrmidon-hermes:pr-check --version/);
  });

  it("builds and checks the development variant only in this repository, never pushing on a pull request", () => {
    const devJob = workflow.slice(workflow.indexOf("  build-dev:"));
    assert.ok(devJob.length > 0, "the workflow must define a build-dev job");
    assert.match(devJob, /IMAGE: ghcr\.io\/itkadr-git\/myrmidon-hermes-dev\n/);
    assert.match(devJob, /if: \$\{\{ github\.repository == 'itkadr-git\/myrmidon' \}\}/);
    assert.equal(devJob.match(/target: runtime-dev\n/g)?.length, 2);
    assert.match(devJob, /tags: myrmidon-hermes-dev:pr-check\n\s+push: false\n\s+load: true/);
    // The finished image is inspected: its contract label and its user, checked
    // against the image the PR build loaded (named by the variable `img`).
    assert.match(devJob, /img=myrmidon-hermes-dev:pr-check/);
    assert.match(devJob, /docker image inspect[^\n]*myrmidon\.bot-runtime\.contract[^\n]*"\$img"/);
    assert.match(devJob, /docker image inspect[^\n]*\.Config\.User[^\n]*"\$img"/);
    // The toolchain is exercised on a read-only root as the contract user.
    assert.match(devJob, /--read-only --user 10001:10001/);
    assert.match(devJob, /run go version/);
  });

  it("builds on push to main and myr-v* tags", () => {
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /tags: \["myr-v\*"\]/);
  });
});
