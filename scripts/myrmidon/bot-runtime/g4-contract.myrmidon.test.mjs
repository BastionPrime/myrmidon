import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(G4): contract check of the hermes_gateway adapter against the real
// CI-built bot runtime image (ghcr.io/itkadr-git/myrmidon-hermes), not against
// stubs. The adapter's cancellation, stop, approval auto-deny and idempotent
// attach paths depend on the hermes version pinned in that image; nothing else
// verifies them against the shipped artifact. The heavy live-gateway part
// (docker run, mock provider, /stop, Idempotency-Key replay) runs through
// docker/bot-runtime/g4-contract-check.sh and is executed here only when
// G4_CONTRACT_CHECK_IMAGE is set AND a docker daemon is reachable — CI and a
// local operator can opt in, plain `node --test` environments skip. The static
// assertions below (script exists, wiring documented) always run.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECK_SCRIPT = path.join(ROOT, "docker", "bot-runtime", "g4-contract-check.sh");
const BOT_RUNTIME_README = path.join(ROOT, "docker", "bot-runtime", "README.md");
const DIVERGENCE = path.join(ROOT, "docs", "myrmidon", "DIVERGENCE.md");

function haveDocker() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function freePort() {
  // The check script serves the gateway on PORT and the mock provider on
  // PORT+1; pick a port pair unlikely to collide with anything else.
  return 38640 + (process.pid % 200) * 2;
}

describe("docker/bot-runtime/g4-contract-check.sh (G4 adapter contract)", () => {
  it("exists, is executable, and passes bash syntax validation", () => {
    assert.ok(fs.existsSync(CHECK_SCRIPT), "g4-contract-check.sh is missing");
    const mode = fs.statSync(CHECK_SCRIPT).mode & 0o777;
    assert.ok(mode & 0o111, "g4-contract-check.sh must be executable");
    const syntax = spawnSync("bash", ["-n", CHECK_SCRIPT], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `bash -n failed:\n${syntax.stderr}`);
  });

  it("covers the G4 wire contract: idempotency, stop, approval, YOLO switch", () => {
    const script = fs.readFileSync(CHECK_SCRIPT, "utf8");
    // Idempotency-Key replay + conflict (the property L1 relies on)
    assert.match(script, /Idempotency-Key/);
    assert.match(script, /replayed/);
    assert.match(script, /idempotency_key_conflict/);
    // /stop of a live run reaching a cancelled terminal status via SSE
    assert.match(script, /\/v1\/runs\/\$\{?[A-Za-z_]+\/stop|run\.cancelled/);
    assert.match(script, /run\.cancelled/);
    // approval endpoint gate
    assert.match(script, /approval_not_active|\/approval/);
    // environment switch for approvals
    assert.match(script, /MYRMIDON_BOT_YOLO/);
    assert.match(script, /HERMES_YOLO_MODE=1/);
    // secrets hygiene: the gateway key is generated, never a literal
    assert.match(script, /openssl rand -hex 32/);
    assert.doesNotMatch(script, /API_SERVER_KEY="[0-9a-f]{16,}"/);
  });

  it("is documented in docker/bot-runtime/README.md and DIVERGENCE.md", () => {
    const readme = fs.readFileSync(BOT_RUNTIME_README, "utf8");
    assert.match(readme, /G4 adapter contract check/);
    assert.match(readme, /g4-contract-check\.sh/);
    const divergence = fs.readFileSync(DIVERGENCE, "utf8");
    assert.match(divergence, /g4-contract-check\.sh/);
  });

  it("live: runs the five contract groups against the CI-built image (opt-in)", { skip: !(process.env.G4_CONTRACT_CHECK_IMAGE && haveDocker()) }, () => {
    const image = process.env.G4_CONTRACT_CHECK_IMAGE;
    assert.match(image, /^[\w./:@-]+$/, "image reference looks malformed");
    const port = freePort();
    // The check script needs a workdir the docker daemon can bind-mount: on a
    // sandboxed shell /tmp is a private tmpfs namespace invisible to dockerd,
    // so point it at the repository checkout (same filesystem the daemon uses).
    const result = spawnSync(
      "bash",
      [CHECK_SCRIPT, image, String(port)],
      { encoding: "utf8", timeout: 15 * 60_000, cwd: ROOT, env: { ...process.env, G4_CHECK_WORKDIR: ROOT } },
    );
    assert.equal(
      result.status,
      0,
      `g4-contract-check.sh failed against ${image}:\n${(result.stdout || "") + (result.stderr || "")}`,
    );
    assert.match(result.stdout, /1\. health\/auth gates ok/);
    assert.match(result.stdout, /2\. idempotency ok/);
    assert.match(result.stdout, /3\. \/stop ok/);
    assert.match(result.stdout, /4\. approval gate ok/);
    assert.match(result.stdout, /5a\. MYRMIDON_BOT_YOLO=1/);
    assert.match(result.stdout, /5b\. MYRMIDON_BOT_YOLO=0/);
    assert.match(result.stdout, /G4 contract check passed/);
  });
});
