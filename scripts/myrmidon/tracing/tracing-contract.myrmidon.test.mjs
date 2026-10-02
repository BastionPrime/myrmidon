import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// TRACING-HEALTH (part E): the CI contract test for the tracing path.
//
// The 02.10 incident class is a tracing path that looks configured and ships
// nothing: Langfuse v4 runs in `events_only` write mode and rejects the legacy
// `/api/public/ingestion` events that LiteLLM keeps sending while the legacy
// `langfuse` callback is installed. Nothing static can tell which path actually
// ships events, so the live lane starts the real stack
// (docker/tracing/docker-compose.contract.yml: LiteLLM + Langfuse v4 +
// ClickHouse + stores), sends ONE completion and asserts exactly ONE OTEL event
// in ClickHouse `events_core` with ZERO ingestion rejections.
//
// Shape follows docker/bot-runtime/g4-contract-check.sh and its wrapper
// scripts/myrmidon/bot-runtime/g4-contract.myrmidon.test.mjs: the static
// assertions below always run; the live lane is opt-in (TRACING_CONTRACT_LIVE=1)
// AND requires a reachable docker daemon, so a plain `node --test` skips it
// cleanly instead of failing.
//
// One of the static assertions is the red-side guard for the operator
// requirement "pin explicit image tags, not `langfuse:4`": it is the same
// refusal scripts/myrmidon/deploy/deploy.sh applies to
// MYRMIDON_TRACING_LANGFUSE_IMAGE / MYRMIDON_TRACING_GATEWAY_IMAGE, and it has
// its own self-test here so a mutated compose tag cannot slip through.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = path.join(ROOT, "docker", "tracing");
const COMPOSE = path.join(HERE, "docker-compose.contract.yml");
const CHECK_SCRIPT = path.join(HERE, "tracing-contract-check.sh");
const LITELLM_CONFIG = path.join(HERE, "litellm.config.yaml");
const README = path.join(HERE, "README.md");

const OTLP_CALLBACK = "langfuse_otel";
const LEGACY_CALLBACK = "langfuse";

// An image reference is pinned when it carries a digest, or a full X.Y.Z tag.
// A major or minor tag (`langfuse/langfuse:4`, `postgres:17`), `latest` and an
// untagged name are not pins: the registry may move them under the contract.
const PINNED_TAG = /^v?\d+\.\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

export function pinViolations(composeText) {
  const violations = [];
  for (const line of composeText.split("\n")) {
    const match = /^\s*image:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const ref = match[1];
    if (DIGEST.test(ref)) continue;
    const tag = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : "";
    if (!tag) {
      violations.push(`${ref}: untagged (add an exact X.Y.Z tag or a digest)`);
      continue;
    }
    if (tag === "latest") {
      violations.push(`${ref}: 'latest' is not a pin`);
      continue;
    }
    if (!PINNED_TAG.test(tag)) {
      violations.push(`${ref}: '${tag}' is not an exact X.Y.Z tag (a major/minor tag moves under the contract)`);
    }
  }
  return violations;
}

function haveDocker() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return probe.status === 0 && String(probe.stdout || "").trim().length > 0;
}

describe("docker/tracing/docker-compose.contract.yml + tracing-contract-check.sh (TRACING-HEALTH contract)", () => {
  it("the check script exists, is executable, and passes bash syntax validation", () => {
    assert.ok(fs.existsSync(CHECK_SCRIPT), "docker/tracing/tracing-contract-check.sh is missing");
    const mode = fs.statSync(CHECK_SCRIPT).mode & 0o777;
    assert.ok(mode & 0o111, "tracing-contract-check.sh must be executable");
    const syntax = spawnSync("bash", ["-n", CHECK_SCRIPT], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `bash -n failed:\n${syntax.stderr}`);
  });

  it("every image in the contract compose carries an exact tag or a digest", () => {
    const compose = fs.readFileSync(COMPOSE, "utf8");
    const violations = pinViolations(compose);
    assert.deepEqual(violations, [], `unpinned images in docker/tracing/docker-compose.contract.yml:\n${violations.join("\n")}`);
    // The pair is the contract: the same Langfuse version on both services,
    // caught by the exact move the incident class came from (`:4`).
    assert.match(compose, /^\s*image:\s*docker\.langfuse\.com\/langfuse\/langfuse:\d+\.\d+\.\d+\s*$/m);
    assert.match(compose, /^\s*image:\s*docker\.langfuse\.com\/langfuse\/langfuse-worker:\d+\.\d+\.\d+\s*$/m);
    const web = /langfuse\/langfuse:(\d+\.\d+\.\d+)/.exec(compose);
    const worker = /langfuse\/langfuse-worker:(\d+\.\d+\.\d+)/.exec(compose);
    assert.ok(web && worker, "the langfuse web/worker images must be present");
    assert.equal(web[1], worker[1], "langfuse-web and langfuse-worker must pin the same version");
    assert.match(compose, /^\s*image:\s*ghcr\.io\/berriai\/litellm:v\d+\.\d+\.\d+\s*$/m);
  });

  it("the pin guard itself refuses a floating tag (red-side self-test)", () => {
    const compose = fs.readFileSync(COMPOSE, "utf8");
    // The exact mutation the acceptance criteria name: a major-only tag.
    const mutated = compose.replace(
      /^(\s*image:\s*)docker\.langfuse\.com\/langfuse\/langfuse:\S+$/m,
      (_line, prefix) => `${prefix}docker.langfuse.com/langfuse/langfuse:4`,
    );
    assert.notEqual(mutated, compose, "the mutation must change the compose file");
    const violations = pinViolations(mutated);
    assert.equal(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations)}`);
    assert.match(violations[0], /langfuse\/langfuse:4: '4' is not an exact X\.Y\.Z tag/);
    // A digest is the other accepted form, and an untagged image never passes.
    assert.deepEqual(pinViolations("    image: example.com/x@sha256:" + "a".repeat(64)), []);
    assert.equal(pinViolations("    image: example.com/x").length, 1);
    assert.equal(pinViolations("    image: example.com/x:latest").length, 1);
  });

  it("the contract compose publishes nothing beyond loopback", () => {
    const compose = fs.readFileSync(COMPOSE, "utf8");
    const published = [];
    let inPorts = false;
    for (const line of compose.split("\n")) {
      if (/^\s*ports:\s*$/.test(line)) {
        inPorts = true;
        continue;
      }
      if (!inPorts) continue;
      if (/^\s*#/.test(line) || line.trim() === "") continue;
      const entry = /^\s*-\s*(?:"([^"]*)"|(\S+))\s*(?:#.*)?$/.exec(line);
      if (entry) {
        published.push(entry[1] ?? entry[2]);
        continue;
      }
      inPorts = false;
    }
    assert.ok(published.length > 0, "the compose must publish the ports the check needs");
    for (const mapping of published) {
      assert.match(mapping, /^127\.0\.0\.1:.+:\d+$/, `published port is not bound to loopback: ${mapping}`);
    }
  });

  it("the gateway installs the OTLP callback only (never the legacy one)", () => {
    const config = fs.readFileSync(LITELLM_CONFIG, "utf8");
    const callbacks = /callbacks:\s*\[([^\]]*)\]/.exec(config);
    assert.ok(callbacks, "litellm.config.yaml must declare litellm_settings.callbacks");
    const names = callbacks[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    assert.deepEqual(names, [OTLP_CALLBACK], `the callback list must be exactly ["${OTLP_CALLBACK}"], got ${JSON.stringify(names)}`);
    assert.ok(!names.includes(LEGACY_CALLBACK), "the legacy 'langfuse' callback must not be configured");
    // No provider is contacted: the stub lives on the invoking host's loopback.
    assert.match(config, /os\.environ\/TRACING_CONTRACT_MOCK_BASE_URL/);
    assert.match(config, /os\.environ\/LITELLM_MASTER_KEY/);
  });

  it("the check script asserts the contract's teeth, not 'at least one'", () => {
    const script = fs.readFileSync(CHECK_SCRIPT, "utf8");
    // exactly ONE trace and ONE model call for the ONE completion
    assert.match(script, /expected exactly ONE OTEL trace for the ONE completion/);
    assert.match(script, /expected exactly ONE model-call observation \(GENERATION\)/);
    assert.match(script, /expected exactly 2 rows in events_core/);
    // zero ingestion rejections, both markers of the incident
    assert.match(script, /grep -icE 'rejected\|bad request'/);
    assert.match(script, /api errors occurred/);
    // and the same fact from the other side: every row arrived over OTLP, none
    // through the legacy ingestion route
    assert.match(script, /countIf\(source = 'otel'\)/);
    assert.match(script, /uniqExact\(ingestion_api_key\)/);
    assert.match(script, /public\/ingestion/);
    // credentials are generated for the run and never literals
    assert.match(script, /rand_hex\(\)/);
    assert.doesNotMatch(script, /(sk|pk)-lf-[0-9a-f]{8,}/);
    assert.match(script, /ENCRYPTION_KEY=/);
  });

  it("is documented in docker/tracing/README.md", () => {
    const readme = fs.readFileSync(README, "utf8");
    assert.match(readme, /tracing-contract-check\.sh/);
    assert.match(readme, /events_core/);
  });

  it("live: one completion -> one OTEL event, zero rejections (opt-in)", { skip: !(process.env.TRACING_CONTRACT_LIVE && haveDocker()) }, () => {
    const result = spawnSync("bash", [CHECK_SCRIPT], {
      encoding: "utf8",
      timeout: 45 * 60_000,
      cwd: ROOT,
      env: { ...process.env, TRACING_CONTRACT_WORKDIR: process.env.TRACING_CONTRACT_WORKDIR || ROOT },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, `tracing-contract-check.sh failed:\n${output}`);
    assert.match(output, /1\. stack up:/);
    assert.match(output, /2\. one completion accepted/);
    assert.match(output, /3\. exactly ONE OTEL trace \(1 root SPAN \+ 1 GENERATION\) in events_core for the one completion/);
    assert.match(output, /4\. zero ingestion rejections \(langfuse 0, gateway 0\)/);
    assert.match(output, /tracing contract check passed/);
  });
});