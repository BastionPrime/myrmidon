import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(TRACING-PINS): the release-manifest guard for the tracing pair.
//
// The 02.10 incident class is a tracing PATH that ships a mismatched pair:
// Langfuse v4 runs in `events_only` write mode, where the legacy
// `/api/public/ingestion` endpoint rejects the trace/observation events that a
// LiteLLM gateway keeps sending while the legacy `langfuse` callback is
// installed. Part A refuses that callback at deploy time; the contract test
// (`docker/tracing/docker-compose.contract.yml`) pins and tests the exact pair
// LIVE. This guard ties the release manifest to that tested pair: the release
// bundle cannot carry a different Langfuse/LiteLLM combination than the one the
// contract test ran. A bump of one image without the other fails here, and
// without a re-run of the live contract lane it is exactly the incident class.
//
// One source of truth: scripts/myrmidon/tracing/tracing-image-pins.json names
// the `langfuse`, `langfuse-worker` and `litellm` images. The release-support
// surface (scripts/myrmidon/dockergate/check-release-support.sh --tracing-pins)
// resolves those components from the file, and the assertions below keep the
// file equal to the contract compose.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PINS = path.join(ROOT, "scripts", "myrmidon", "tracing", "tracing-image-pins.json");
const COMPOSE = path.join(ROOT, "docker", "tracing", "docker-compose.contract.yml");
const RELEASE_SUPPORT = path.join(ROOT, "scripts", "myrmidon", "dockergate", "check-release-support.sh");
const DEPLOY_MD = path.join(ROOT, "docs", "myrmidon", "deploy.md");
const DEPLOY_RU = path.join(ROOT, "docs", "myrmidon", "deploy.ru.md");

// An image reference is pinned when it carries a digest, or a full X.Y.Z tag.
// A major or minor tag (`langfuse/langfuse:4`, `litellm:v1`), `latest` and an
// untagged name are not pins: the registry may move them under the contract.
const PINNED_TAG = /^v?\d+\.\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMPONENTS = ["langfuse", "langfuse-worker", "litellm"];
// The tracing images in the compose are exactly these families; anything else
// matching the family is an unmatched/mismatched reference.
const TRACING_IMAGE = /langfuse\/langfuse|berriai\/litellm/;

/** The `<repo>:<tag>` or `<repo>@<digest>` reference a pinned component names. */
export function imageRef(entry) {
  assert.ok(entry && typeof entry === "object", "each pinned component must be an object");
  assert.ok(
    typeof entry.repository === "string" && entry.repository.length > 0,
    "each pinned component needs a repository",
  );
  if (entry.digest !== undefined) {
    assert.match(entry.digest, DIGEST, `${entry.repository}: digest must be sha256:<64 hex>`);
    return `${entry.repository}@${entry.digest}`;
  }
  assert.ok(
    typeof entry.tag === "string" && entry.tag.length > 0,
    "each pinned component needs a tag or a digest",
  );
  assert.match(entry.tag, PINNED_TAG, `${entry.repository}:${entry.tag} is not an exact X.Y.Z tag or a digest`);
  return `${entry.repository}:${entry.tag}`;
}

/** Every `image:` reference of a compose file, in order. */
export function composeImages(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const match = /^\s*image:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

/**
 * The problems that make the release manifest and the contract compose disagree
 * about the tracing pair. Empty means the manifest pins exactly the pair the
 * contract test runs.
 */
export function pinProblems(pins, composeText) {
  const problems = [];
  const components = pins && typeof pins === "object" && pins.components ? pins.components : {};
  for (const name of COMPONENTS) {
    if (!components[name]) {
      problems.push(`pins file does not name component '${name}'`);
      continue;
    }
    try {
      imageRef(components[name]);
    } catch (error) {
      problems.push(`component '${name}': ${error.message}`);
    }
  }
  const web = components.langfuse;
  const worker = components["langfuse-worker"];
  if (web && worker && web.tag !== worker.tag) {
    problems.push(`langfuse (${web.tag}) and langfuse-worker (${worker.tag}) must pin the same version`);
  }
  const images = composeImages(composeText);
  const pinned = [];
  for (const name of COMPONENTS) {
    if (!components[name]) continue;
    let ref;
    try {
      ref = imageRef(components[name]);
    } catch {
      continue;
    }
    pinned.push(ref);
    if (!images.includes(ref)) {
      problems.push(`the contract compose does not run the pinned ${name} image ${ref}`);
    }
  }
  for (const image of images) {
    if (!TRACING_IMAGE.test(image)) continue;
    if (!pinned.includes(image)) {
      problems.push(`the contract compose runs a tracing image outside the manifest pins: ${image}`);
    }
  }
  return problems;
}

function pinsText() {
  return fs.readFileSync(PINS, "utf8");
}

function readPins() {
  assert.ok(fs.existsSync(PINS), "scripts/myrmidon/tracing/tracing-image-pins.json is missing");
  return JSON.parse(pinsText());
}

describe("scripts/myrmidon/tracing/tracing-image-pins.json (TRACING-PINS release manifest)", () => {
  it("names the Langfuse server, its worker and the LiteLLM gateway", () => {
    const pins = readPins();
    for (const name of COMPONENTS) {
      assert.ok(pins.components && pins.components[name], `the pins file must name component '${name}'`);
    }
  });

  it("pins every tracing component by an exact X.Y.Z tag or a digest", () => {
    const pins = readPins();
    for (const name of COMPONENTS) {
      const ref = imageRef(pins.components[name]);
      assert.ok(ref.length > 0, `${name} must resolve to an image reference`);
    }
  });

  it("pins the Langfuse server and its worker at the same version", () => {
    const pins = readPins();
    assert.equal(
      pins.components.langfuse.tag,
      pins.components["langfuse-worker"].tag,
      "langfuse and langfuse-worker must pin the same version",
    );
  });

  it("keeps the manifest equal to the tested contract compose (the tested pair)", () => {
    const pins = readPins();
    const compose = fs.readFileSync(COMPOSE, "utf8");
    const problems = pinProblems(pins, compose);
    assert.deepEqual(
      problems,
      [],
      `the release manifest and docker/tracing/docker-compose.contract.yml disagree:\n${problems.join("\n")}`,
    );
  });

  it("refuses a manifest that drifts from the contract compose (red-side self-test)", () => {
    const pins = readPins();
    const compose = fs.readFileSync(COMPOSE, "utf8");
    // The exact mismatch class: a bump of ONE side only.
    const bumped = JSON.parse(JSON.stringify(pins));
    bumped.components.langfuse.tag = "4.50.0";
    const drift = pinProblems(bumped, compose);
    assert.ok(drift.length > 0, "a one-sided bump must be reported");
    assert.ok(
      drift.some((problem) => problem.includes("does not run the pinned langfuse image")),
      `expected a compose mismatch, got: ${JSON.stringify(drift)}`,
    );
    // The worker moving alone must be refused as well.
    const workerAlone = JSON.parse(JSON.stringify(pins));
    workerAlone.components["langfuse-worker"].tag = "4.50.0";
    assert.ok(
      pinProblems(workerAlone, compose).some((problem) => problem.includes("must pin the same version")),
      "a worker-only bump must be refused",
    );
    // A floating tag is not a pin.
    const floating = JSON.parse(JSON.stringify(pins));
    floating.components.litellm.tag = "v1";
    assert.ok(
      pinProblems(floating, compose).some((problem) => problem.includes("is not an exact X.Y.Z tag")),
      "a major-only tag must be refused",
    );
    // The compose moving without the manifest is the other direction.
    const mutatedCompose = compose.replace(
      /^(\s*image:\s*)docker\.langfuse\.com\/langfuse\/langfuse:\S+$/m,
      (_line, prefix) => `${prefix}docker.langfuse.com/langfuse/langfuse:4.50.0`,
    );
    assert.notEqual(mutatedCompose, compose, "the compose mutation must change the file");
    assert.ok(
      pinProblems(pins, mutatedCompose).length > 0,
      "a compose-only bump must be reported",
    );
  });

  it("is resolvable through the release-support surface (one source of truth)", () => {
    const script = fs.readFileSync(RELEASE_SUPPORT, "utf8");
    for (const name of COMPONENTS) {
      assert.match(
        script,
        new RegExp(`\\[${name.replace("-", "\\-")}\\]`),
        `check-release-support.sh must know the '${name}' component`,
      );
    }
    assert.match(script, /tracing-image-pins\.json/, "check-release-support.sh must read the pins file");
    assert.match(script, /--tracing-pins/, "check-release-support.sh must expose the --tracing-pins mode");
  });

  it("is documented as a tested pair in both deploy guides", () => {
    // Language-neutral markers: the pins file (the pair) and the contract test
    // command whose re-run a bump requires. Both guides carry the same note.
    for (const guide of [DEPLOY_MD, DEPLOY_RU]) {
      const text = fs.readFileSync(guide, "utf8");
      assert.match(text, /tracing-image-pins\.json/, `${path.basename(guide)} must name the pins file`);
      assert.match(
        text,
        /tracing-contract-check\.sh/,
        `${path.basename(guide)} must require re-running the contract test before a bump`,
      );
    }
  });
});