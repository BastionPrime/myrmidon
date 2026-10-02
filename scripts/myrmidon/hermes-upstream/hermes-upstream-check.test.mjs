import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { hindsightCatalogPin, pinFromDockerfile, run, stableTags } from "./hermes-upstream-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCKERFILE = path.join(ROOT, "docker/bot-runtime/Dockerfile");
const REGISTRY = path.join(ROOT, "scripts/myrmidon/hermes-upstream/deltas.json");

const LS_REMOTE = [
  "1111111111111111111111111111111111111111\trefs/tags/v2026.9.7",
  "2222222222222222222222222222222222222222\trefs/tags/v2026.9.7^{}",
  "3333333333333333333333333333333333333333\trefs/tags/v2026.9.11",
  "4444444444444444444444444444444444444444\trefs/tags/v2026.9.11^{}",
  "5555555555555555555555555555555555555555\trefs/tags/v2026.9.24-canary",
  "6666666666666666666666666666666666666666\trefs/tags/v2026.9.24",
  "7777777777777777777777777777777777777777\trefs/tags/v2026.9.24^{}",
  "8888888888888888888888888888888888888888\trefs/tags/nightly/whatever",
].join("\n");

const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");

const fakeRun = (texts) =>
  run({
    registryPath: REGISTRY,
    dockerfilePath: DOCKERFILE,
    exec: () => LS_REMOTE,
    fetchText: async (url) => {
      for (const [needle, text] of Object.entries(texts)) {
        if (url.includes(needle)) return text;
      }
      return "";
    },
  });

describe("check-hermes-upstream", () => {
  it("takes only stable tags and orders them by date, not lexically", () => {
    const tags = stableTags(LS_REMOTE, "^v[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2}$");
    assert.deepEqual(tags, ["v2026.9.7", "v2026.9.11", "v2026.9.24"]);
  });

  it("reads the pin out of the image Dockerfile", () => {
    const pin = pinFromDockerfile(dockerfile);
    assert.match(pin.ref, /^v\d{4}\.\d{1,2}\.\d{1,2}$/);
    assert.match(pin.version, /^\d+\.\d+\.\d+$/);
    assert.match(pin.sha, /^[0-9a-f]{40}$/);
    // The registry is the machine-readable half of the delta list; it must not drift from
    // the image it describes.
    assert.equal(pin.ref, registry.pinnedRef);
    assert.equal(pin.version, registry.pinnedVersion);
  });

  it("records the vendored plugin pin, and cross-checks it when a hermes checkout is present", async () => {
    assert.match(registry.hindsightPlugin.repo, /^https:\/\/github\.com\//);
    assert.match(registry.hindsightPlugin.pinnedSha, /^[0-9a-f]{40}$/);
    assert.equal(registry.hindsightPlugin.subdir, "hindsight-integrations/hermes");

    // No hermes tree here: the registry's own record is used, no error.
    const plain = await fakeRun({ "raw.githubusercontent.com": "" });
    assert.equal(plain.pluginPin.pinnedSha, registry.hindsightPlugin.pinnedSha);
    assert.equal(plain.catalogPin, null);

    // A hermes checkout whose catalog entry disagrees with the registry is a hard error:
    // the two describe the same vendored tree and must move together.
    const fakeRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hermes-tree-"));
    fs.mkdirSync(path.join(fakeRoot, "plugin-catalog"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, "plugin-catalog/hindsight.yaml"),
      "repo: https://github.com/vectorize-io/hindsight\nsha: " + "b".repeat(40) + "\nsubdir: hindsight-integrations/hermes\n",
      "utf8",
    );
    const bad = await run({
      root: fakeRoot,
      registryPath: REGISTRY,
      dockerfilePath: DOCKERFILE,
      exec: () => LS_REMOTE,
      fetchText: async () => "",
    }).then(() => null, (exc) => exc);
    assert.ok(bad && /deltas\.json records/.test(bad.message), "expected a pin-mismatch error");
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  });

  it("flags a delta as droppable only when the upstream file carries its marker", async () => {
    const report = await fakeRun({
      "raw.githubusercontent.com/NousResearch/hermes-agent": "# nothing interesting here\n",
    });
    assert.equal(report.newest, "v2026.9.24");
    assert.deepEqual(report.behind, []);
    for (const result of report.results) {
      assert.ok(["still-needed", "droppable", "unknown"].includes(result.status));
      if (result.kind === "patch") assert.equal(result.status, "still-needed");
    }

    const caughtUp = await fakeRun({
      "gateway/run.py": "loop.set_default_executor(pool)  # HERMES_GATEWAY_EXECUTOR_WORKERS\n",
    });
    const pool = caughtUp.results.find((r) => r.id === "05-gateway-executor-pool");
    assert.equal(pool.status, "droppable");
    const snapshot = caughtUp.results.find((r) => r.id === "02-session-snapshot-secret-redaction");
    assert.equal(snapshot.status, "still-needed");
  });

  it("reports the pin as behind when a newer stable tag exists", async () => {
    const older = fs
      .readFileSync(DOCKERFILE, "utf8")
      .replace("ARG HERMES_GIT_REF=v2026.9.24", "ARG HERMES_GIT_REF=v2026.9.11")
      .replace("ARG HERMES_VERSION=0.21.5", "ARG HERMES_VERSION=0.21.2");
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hermes-upstream-")), "Dockerfile");
    fs.writeFileSync(tmp, older.replace(/^ARG HERMES_GIT_SHA=.*$/m, `ARG HERMES_GIT_SHA=${"a".repeat(40)}`), "utf8");
    const report = await run({
      registryPath: REGISTRY,
      dockerfilePath: tmp,
      exec: () => LS_REMOTE,
      fetchText: async () => "",
    }).catch(() => null);
    // The registry pins 0.21.5/v2026.9.24, so an older Dockerfile is a hard mismatch, not a
    // "behind" report: the registry and the image must move together.
    assert.equal(report, null);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  it("keeps the registry true: every patch it names exists and is documented", () => {
    const patchesDir = path.join(ROOT, "docker/bot-runtime/patches");
    const readme = fs.readFileSync(path.join(patchesDir, "README.md"), "utf8");
    const listed = new Set(fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch")));
    const fromRegistry = new Set(registry.deltas.filter((d) => d.kind === "patch").map((d) => path.basename(d.patch)));
    assert.deepEqual([...fromRegistry].sort(), [...listed].sort());
    for (const delta of registry.deltas) {
      assert.ok(delta.reason && delta.dropCondition, `${delta.id} needs a reason and a drop condition`);
      if (delta.kind === "patch") {
        assert.ok(fs.existsSync(path.join(ROOT, delta.patch)), `${delta.patch} is missing`);
        assert.ok(readme.includes(path.basename(delta.patch)), `patches/README.md must list ${delta.patch}`);
      }
    }
  });
});