import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBody,
  COMPONENTS,
  componentDigest,
  componentDigests,
  extractChangelogSection,
  previousMinorPatch,
} from "./release-body.mjs";

// RELEASE-PUBLISH (the 02.10 gap): integration tests of the automatic GitHub
// Release flow. The real script (publish-github-release.sh) runs against a
// fake `gh` and `node` in PATH; no test touches GitHub, the registry or a
// real tag. Same harness pattern as deploy/release-gate.test.mjs.
//
// The body builder (release-body.mjs) is covered separately with an
// injected fetch: changelog section extraction, missing-section refusal,
// digest resolution, missing-digest refusal, the full body shape.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "publish-github-release.sh");
const BUILDER = path.join(HERE, "release-body.mjs");
const REPO = "itkadr-git/myrmidon";
const COMMIT = "c78a6c9fde4992a98e5e76d3fd556e33bb87935a";
const TAG_OBJECT = "0123456789abcdef0123456789abcdef01234567";

const CHANGELOG = `# Myrmidon changelog

## 1.6.0

- New thing A.
- New thing B.

## 1.5.0

- Old thing.

## 1.4.0

- Older thing.
`;

// The fake gh answers by URL/argument shape. State lives in the sandbox dir:
//   runs.json          workflow runs for the tag commit (API answers)
//   releases.json      existing releases (tag -> {name, body})
//   ref-tag.json       the tag ref (annotated -> tag object)
//   tag-object.json    the annotated tag object (-> commit)
// The fake records every release mutation into mutations.log for assertions.
const FAKE_GH = `#!/usr/bin/env bash
# Fake gh: answers the API GETs from files in $SANDBOX, records release
# mutations into mutations.log. Argument parsing is a plain loop so the
# embedded script survives being a JS template literal.
echo "gh $*" >> "$SANDBOX/calls.log"
set -euo pipefail
sub="$1"; shift
case "$sub" in
  api)
    # collect: first non-flag argument is the URL, --jq carries the filter
    url=""; jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --jq) shift; jq_filter="$1" ;;
        -*) ;; # --paginate and friends
        *) if [ -z "$url" ]; then url="$1"; fi ;;
      esac
      shift
    done
    body=""
    case "$url" in
      *"/git/ref/tags/"*) body="$(cat "$SANDBOX/ref-tag.json")" ;;
      *"/git/tags/"*)     body="$(cat "$SANDBOX/tag-object.json")" ;;
      *"actions/runs?head_sha="*) body="$(cat "$SANDBOX/runs.json")" ;;
      *) body="{}" ;;
    esac
    if [ -n "$jq_filter" ]; then
      jq "$jq_filter" <<<"$body"
    else
      printf '%s\n' "$body"
    fi ;;
  release)
    verb="$1"; shift
    tag=""; title=""; notes=""; jq_filter=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --title) shift; title="$1" ;;
        --notes-file) shift; notes="$1" ;;
        --jq) shift; jq_filter="$1" ;;
        myr-v*) tag="$1" ;;
      esac
      shift
    done
    case "$verb" in
      view)
        # The script calls: gh release view <tag> --json name --jq '.name'
        # (--json without --jq prints the object). The filter applies to the
        # release object, not the whole map.
        if jq -e --arg t "$tag" 'has($t)' "$SANDBOX/releases.json" >/dev/null; then
          if [ -n "$jq_filter" ]; then
            # gh --jq prints raw strings (jq -r semantics)
            jq -r --arg t "$tag" '.[$t] | '"$jq_filter" "$SANDBOX/releases.json"
          else
            jq --arg t "$tag" '{name: .[$t].name, body: .[$t].body}' "$SANDBOX/releases.json"
          fi
        else
          echo "release not found: $tag" >&2
          exit 1
        fi ;;
      create)
        printf 'create tag=%s title=%s notes=%s\n' "$tag" "$title" "$(cat "$notes")" >> "$SANDBOX/mutations.log"
        jq --arg t "$tag" --arg n "$title" --arg b "$(cat "$notes")" \
          '.[$t] = {name: $n, body: $b}' "$SANDBOX/releases.json" > "$SANDBOX/releases.json.tmp"
        mv "$SANDBOX/releases.json.tmp" "$SANDBOX/releases.json" ;;
      edit)
        # Record the mutation with the notes CONTENT (when a file is given),
        # then apply it to the state file so a later view sees the edit.
        notes_content=""
        if [ -n "$notes" ] && [ -f "$notes" ]; then notes_content="$(cat "$notes")"; fi
        printf 'edit target=%s title=%s notes=%s\n' "$tag" "$title" "$notes_content" >> "$SANDBOX/mutations.log"
        if [ -n "$tag" ]; then
          new_title="$title"
          if jq -e --arg t "$tag" 'has($t)' "$SANDBOX/releases.json" >/dev/null 2>&1 \
             && [ "$new_title" != "null" ] && [ -n "$new_title" ]; then
            if [ -n "$notes_content" ] || [ -n "$new_title" ]; then
              jq --arg t "$tag" --arg n "$new_title" '.[$t].name = $n' "$SANDBOX/releases.json" > "$SANDBOX/releases.json.tmp"
              mv "$SANDBOX/releases.json.tmp" "$SANDBOX/releases.json"
            fi
          fi
        fi ;;
    esac ;;
  *) echo "unexpected gh subcommand: $sub" >&2; exit 1 ;;
esac
`;

function writeFakeGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  return bin;
}

function sandbox({ runs = [], releases = {}, changelog = CHANGELOG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-publish-"));
  const bin = writeFakeGh(dir);
  // The checkout the script runs in (cwd): the changelog at its repo path.
  fs.mkdirSync(path.join(dir, "docs/myrmidon"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/myrmidon/CHANGELOG.md"), changelog);
  fs.writeFileSync(path.join(dir, "ref-tag.json"),
    JSON.stringify({ object: { sha: TAG_OBJECT, type: "tag" } }));
  fs.writeFileSync(path.join(dir, "tag-object.json"),
    JSON.stringify({ object: { sha: COMMIT, type: "commit" } }));
  fs.writeFileSync(path.join(dir, "runs.json"), JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  fs.writeFileSync(path.join(dir, "releases.json"), JSON.stringify(releases));
  // Offline digest simulation for release-body.mjs (the same state shape the
  // real registry probe answers): every component present by default.
  const registryState = {};
  for (const { repository } of COMPONENTS) registryState[repository] = `sha256:${repository.length}${"d".repeat(63)}`;
  fs.writeFileSync(path.join(dir, "registry-state.json"), JSON.stringify(registryState));
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "mutations.log"), "");
  return { dir, bin };
}

const run = (sha, pathOfWf, conclusion, status = "completed") => ({
  head_sha: sha, path: pathOfWf, status, conclusion,
});

function runScript(sb, tag, { extraEnv = {} } = {}) {
  const result = spawnSync("bash", [SCRIPT, "--tag", tag], {
    cwd: sb.dir,
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      SANDBOX: sb.dir,
      GITHUB_REPOSITORY: REPO,
      // offline digest simulation + fast gate polls (the defaults are sized
      // for CI; the tests must not sleep 20 s per poll)
      MYRMIDON_RELEASE_REGISTRY_STATE: path.join(sb.dir, "registry-state.json"),
      MYRMIDON_RELEASE_POLL_SECONDS: "0",
      MYRMIDON_RELEASE_POLL_MAX: "4",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const mutations = (sb) => read(path.join(sb.dir, "mutations.log"));

const GREEN_RUNS = [
  run(COMMIT, ".github/workflows/myrmidon-ci.yml", "success"),
  run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
  run(COMMIT, ".github/workflows/myrmidon-dockergate.yml", "success"),
  run(COMMIT, ".github/workflows/myrmidon-fleetd.yml", "success"),
];

describe("publish-github-release.sh: the CI gate", () => {
  it("refuses to publish when Myrmidon CI failed for the tag commit", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "failure"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon CI did not succeed/);
    assert.match(out, /NOT publishing/);
    assert.equal(mutations(sb), "", "no release mutation happened");
  });

  it("refuses to publish when the board image workflow failed", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "failure"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon image \(board\) did not succeed/);
    assert.equal(mutations(sb), "", "no release mutation happened");
  });

  it("refuses to publish when a required run is missing entirely", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /no run of Myrmidon CI found/);
    assert.equal(mutations(sb), "");
  });

  it("publishes when dockergate/fleetd have no run (paths-filtered), but not when they failed", () => {
    // absent: fine
    const sbOk = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const ok = runScript(sbOk, "myr-v1.6.0");
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /no run of Myrmidon dockergate image for .+\(paths-filtered\) — accepted/);
    assert.match(ok.out, /no run of Myrmidon fleetd image for .+\(paths-filtered\) — accepted/);
    assert.match(mutations(sbOk), /create tag=myr-v1\.6\.0/);

    // failed: refuse
    const sbBad = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-fleetd.yml", "failure"),
    ] });
    const bad = runScript(sbBad, "myr-v1.6.0");
    assert.notEqual(bad.code, 0, bad.out);
    assert.match(bad.out, /Myrmidon fleetd image failed/);
    assert.equal(mutations(sbBad), "");
  });

  it("treats a mixed conclusion (a failed attempt among re-runs) as failure", () => {
    const sb = sandbox({ runs: [
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "success"),
      run(COMMIT, ".github/workflows/myrmidon-ci.yml", "failure"),
      run(COMMIT, ".github/workflows/myrmidon-image.yml", "success"),
    ] });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /Myrmidon CI did not succeed.*mixed/);
    assert.equal(mutations(sb), "");
  });
});

describe("publish-github-release.sh: the release body and mutations", () => {
  it("fails loudly when the CHANGELOG section is missing", () => {
    const sb = sandbox({ runs: GREEN_RUNS, changelog: "# Myrmidon changelog\n\n## 1.5.0\n\n- Old thing.\n" });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.notEqual(code, 0, out);
    assert.match(out, /no "## 1\.6\.0" section/i);
    assert.equal(mutations(sb), "");
  });

  it("creates the release with the CHANGELOG section and marks the previous superseded", () => {
    const sb = sandbox({
      runs: GREEN_RUNS,
      releases: { "myr-v1.5.0": { name: "Myrmidon 1.5.0", body: "old body" } },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /create tag=myr-v1\.6\.0 title=Myrmidon 1\.6\.0 notes=.*New thing A\./s);
    assert.match(mut, /edit target=myr-v1\.5\.0 title=Myrmidon 1\.5\.0 \(superseded\)/);
    assert.match(mut, /check-release-support\.sh --from-tag 1\.6\.0/);
  });

  it("is idempotent: an existing release is edited, not duplicated; an already-superseded previous is not renamed again", () => {
    const sb = sandbox({
      runs: GREEN_RUNS,
      releases: {
        "myr-v1.6.0": { name: "Myrmidon 1.6.0", body: "stale body" },
        "myr-v1.5.0": { name: "Myrmidon 1.5.0 (superseded)", body: "old" },
      },
    });
    const { code, out } = runScript(sb, "myr-v1.6.0");
    assert.equal(code, 0, out);
    const mut = mutations(sb);
    assert.match(mut, /edit target=myr-v1\.6\.0 title=Myrmidon 1\.6\.0 notes=Myrmidon 1\.6\.0 replaces/s);
    assert.doesNotMatch(mut, /create tag=/);
    // previous already carries the marker: the edit for 1.5.0 must NOT appear
    assert.doesNotMatch(mut, /edit target=myr-v1\.5\.0/);
  });
});

describe("release-body.mjs: body construction", () => {

  it("extracts the X.Y.Z section and stops at the next heading", () => {
    const section = extractChangelogSection(CHANGELOG, "1.5.0");
    assert.equal(section, "- Old thing.");
    const section6 = extractChangelogSection(CHANGELOG, "1.6.0");
    assert.match(section6, /New thing A\./);
    assert.doesNotMatch(section6, /Old thing/);
  });

  it("returns null for a missing section and for an empty one", () => {
    assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), null);
    assert.equal(extractChangelogSection("## 1.6.0\n\n## 1.5.0\n", "1.6.0"), null);
  });

  it("derives the superseded version (patch, minor, floor)", () => {
    assert.equal(previousMinorPatch("1.5.2"), "1.5.1");
    assert.equal(previousMinorPatch("1.5.0"), "1.4.0");
    assert.equal(previousMinorPatch("1.6.0"), "1.5.0");
    assert.equal(previousMinorPatch("2.0.0"), null);
  });

  it("builds the body: deploy line with the upgrade anchor, notes, digest table", () => {
    const a64 = "a".repeat(64);
    const b64 = "b".repeat(64);
    const body = buildBody({
      version: "1.6.0",
      previous: "1.5.0",
      section: "- New thing A.",
      digestRows: [
        `| board | \`ghcr.io/itkadr-git/myrmidon@sha256:${a64}\` |`,
        `| bot | \`ghcr.io/itkadr-git/myrmidon-hermes@sha256:${b64}\` |`,
      ],
    });
    assert.match(body, /Myrmidon 1\.6\.0 replaces 1\.5\.0\./);
    assert.match(body, /Deploy the board and the release component images \(dockergate, fleetd\) from this tag together/);
    assert.match(body, /"Upgrading from 1\.5\.0 to 1\.6\.0"/);
    assert.match(body, /docs\/myrmidon\/deploy\.md/);
    assert.match(body, /- New thing A\./);
    assert.match(body, /## Component images \(digests\)/);
    assert.match(body, /board \| `ghcr\.io\/itkadr-git\/myrmidon@sha256:a{64}`/);
    assert.match(body, /check-release-support\.sh --from-tag 1\.6\.0/);
    // no private addresses, no token-shaped strings
    assert.doesNotMatch(body, /(?<!\d)(?:10|192|172)\.\d+\.\d+\.\d+(?!\d)/);
  });
});

describe("release-body.mjs: digest resolution (injected fetch)", () => {

  const registryFetch = (digests) => async (url, init) => {
    if (url.startsWith("https://ghcr.io/token")) {
      return { ok: true, json: async () => ({ token: "anonymous" }) };
    }
    const repo = /\/v2\/itkadr-git\/([^/]+)\//.exec(url)[1];
    const digest = digests[repo];
    if (!digest) return { ok: false };
    return {
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === "docker-content-digest" ? digest : null) },
    };
  };

  it("resolves every component digest, one anonymous token per repository", () => {
    const tokenUrls = [];
    const fetchImpl = async (url, init) => {
      if (url.startsWith("https://ghcr.io/token")) {
        tokenUrls.push(url);
        return { ok: true, json: async () => ({ token: "anonymous" }) };
      }
      const repo = /\/v2\/itkadr-git\/([^/]+)\//.exec(url)[1];
      return {
        ok: true,
        headers: { get: () => `sha256:${repo.length}${"c".repeat(63)}` },
      };
    };
    return componentDigests("1.6.0", { fetchImpl }).then(({ rows, missing }) => {
      assert.deepEqual(missing, []);
      assert.equal(rows.length, 4);
      assert.match(rows[0], /board/);
      // one token request per repository (4 components, 4 scopes)
      assert.equal(tokenUrls.length, 4);
    });
  });

  it("reports the missing components instead of publishing partial digests", () => {
    const fetchImpl = registryFetch({ myrmidon: "sha256:x", "myrmidon-hermes": "sha256:y" });
    return componentDigests("1.6.0", { fetchImpl }).then(({ rows, missing }) => {
      assert.deepEqual(missing, ["dockergate", "fleetd"]);
      assert.equal(rows.length, 2);
    });
  });

  it("a registry error resolves to null (fail-closed), not a crash", () => {
    const fetchImpl = async () => { throw new Error("network down"); };
    return componentDigest("myrmidon", "1.6.0", { fetchImpl }).then((d) => {
      assert.equal(d, null);
    });
  });
});
