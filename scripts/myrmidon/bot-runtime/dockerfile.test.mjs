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
const dockerfileInstructions = dockerfile
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe("docker/bot-runtime/Dockerfile", () => {
  it("pins the hermes version through a build arg with an exact default", () => {
    assert.match(dockerfile, /^ARG HERMES_VERSION=\d+\.\d+\.\d+$/m);
    assert.match(dockerfile, /^ARG HERMES_GIT_REF=v\d+\.\d+\.\d+$/m);
    // The tag and the version must actually be the same release.
    const version = dockerfile.match(/^ARG HERMES_VERSION=(\d+\.\d+\.\d+)$/m)[1];
    const ref = dockerfile.match(/^ARG HERMES_GIT_REF=v(\d+\.\d+\.\d+)$/m)[1];
    assert.equal(ref, version, "HERMES_GIT_REF must point at the HERMES_VERSION release");
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

  it("declares volumes for state and workspace, not a host bind", () => {
    assert.match(dockerfile, /^VOLUME \["\/data", "\/workspace"\]$/m);
  });

  it("carries no media tools or Docker socket access", () => {
    assert.doesNotMatch(dockerfileInstructions, /\b(ffmpeg|ffprobe|yt-dlp|youtube-dl)\b/i);
    assert.doesNotMatch(dockerfileInstructions, /docker\.sock/);
  });

  it("does not install hermes-agent from PyPI (unsupported at this release)", () => {
    assert.doesNotMatch(dockerfileInstructions, /pip install[^\n]*hermes-agent/);
  });
});

describe("docker/bot-runtime/patches/", () => {
  it("has a README documenting the patch mechanism, even with no patches yet", () => {
    assert.ok(fs.existsSync(path.join(IMAGE_DIR, "patches/README.md")));
  });
});

describe("myrmidon-bot-image.yml", () => {
  it("publishes to the dedicated bot-image namespace", () => {
    assert.match(workflow, /IMAGE: ghcr\.io\/itkadr-git\/myrmidon-hermes\n/);
  });

  it("only in this repository, and pushes only outside pull_request", () => {
    assert.match(workflow, /if: \$\{\{ github\.repository == 'itkadr-git\/myrmidon' \}\}/);
    assert.match(workflow, /if: \$\{\{ github\.event_name != 'pull_request' \}\}/);
    assert.match(workflow, /push: false/);
  });

  it("builds on push to main and myr-v* tags", () => {
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /tags: \["myr-v\*"\]/);
  });
});
