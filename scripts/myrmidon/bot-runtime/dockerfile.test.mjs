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
    assert.doesNotMatch(dockerfile, /^USER root$/m);
    assert.doesNotMatch(dockerfile, /^USER 0(:0)?$/m);
  });

  it("uses tini as PID 1", () => {
    assert.match(dockerfile, /tini/);
    assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "--",/m);
  });

  it("installs the ssh client without recommended packages", () => {
    assert.match(dockerfileInstructions, /--no-install-recommends[\s\S]*?\bopenssh-client\b/);
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
    assert.match(dockerfile, /uv sync --frozen --extra sms --extra mcp --extra hindsight/);
  });

  it("bakes in mcp and hindsight (every G2-compiled bot profile needs both, not just aiohttp/sms)", () => {
    assert.match(dockerfile, /--extra mcp\b/);
    assert.match(dockerfile, /--extra hindsight\b/);
    // And actually checked, not just requested — a `uv sync` extra silently
    // no-ops if the package name is ever wrong.
    assert.match(dockerfile, /import aiohttp, mcp, hindsight_client/);
  });

  it("import-smokes every module a patch changes, so a patch that applies but breaks a module fails the build", () => {
    // `git apply` only proves the hunks land. The smoke must name one module per patched
    // file: 04 hermes_state, 01/03 the hindsight plugin, 02 the two session-environment files.
    const smoke = dockerfileInstructions.match(/^RUN [^\n]*python -c 'import (hermes_state[^']*)'$/m);
    assert.ok(smoke, "expected a build-time import smoke that starts with hermes_state");
    const modules = smoke[1].split(",").map((m) => m.trim());
    for (const module of [
      "hermes_state",
      "plugins.memory.hindsight",
      "tools.environments.base",
      "tools.environments.base_session_env",
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

  it("ships the hindsight reflect-timeout/retry and session-snapshot secret-redaction patches", () => {
    const patchesDir = path.join(IMAGE_DIR, "patches");
    const files = fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch"));
    assert.ok(files.some((f) => f.includes("hindsight")), "expected a hindsight patch");
    assert.ok(files.some((f) => f.includes("secret")), "expected a session-snapshot secret-redaction patch");
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

  it("passes the configured retain_async from the explicit hindsight retain tool", () => {
    // The tool path used to omit retain_async, so the client default applied and every
    // explicit retain ran synchronously (bounded only by the shared client timeout).
    // With memory_mode "tools" and auto_retain off this tool is the only retain path.
    const patch = fs.readFileSync(
      path.join(IMAGE_DIR, "patches/03-hindsight-tool-retain-async.patch"),
      "utf8",
    );
    assert.match(patch, /^\+\+\+ b\/plugins\/memory\/hindsight\/__init__\.py$/m);
    assert.match(patch, /^-\s+self\._retain_batch\(item, bank_id=self\._bank_id\)$/m);
    assert.match(patch, /^\+\s+self\._retain_batch\(item, bank_id=self\._bank_id, retain_async=self\._retain_async\)$/m);
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
    // The wait is jittered and bounded, and any other OperationalError is still raised at once.
    assert.match(patch, /^\+\s+time\.sleep\(delay \* \(0\.5 \+ random\.random\(\)\)\)$/m);
    assert.match(patch, /^\+\s+raise$/m);
    // No new environment knobs: every such variable would need its own documented setting.
    assert.doesNotMatch(patch, /^\+.*os\.environ/m);
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
    // those two files together with it. The Node.js variant below is not a browser
    // and does not change this: it must not carry one either.
    assert.doesNotMatch(dockerfileInstructions, /chromium|playwright|agent-browser|nodejs|\bnpm\b|\bnpx\b/i);
    const variant = dockerfile.slice(variantStart).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(variant, /chromium|playwright|agent-browser|puppeteer/i);
  });

  it("keeps the Node.js variant a final stage on top of runtime, with the same user, label and no media tools", () => {
    assert.match(dockerfile, /^FROM runtime AS runtime-node$/m);
    const variant = dockerfile.slice(dockerfile.indexOf("FROM runtime AS runtime-node"));
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

  it("builds on push to main and myr-v* tags", () => {
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /tags: \["myr-v\*"\]/);
  });
});
