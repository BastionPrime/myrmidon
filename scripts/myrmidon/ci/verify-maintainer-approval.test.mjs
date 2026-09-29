import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  STATUS_CONTEXT,
  computeApprovalMac,
  evaluateApproval,
  main,
  normalizeKey,
  parseApprovalLines,
} from "./verify-maintainer-approval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const approveScript = path.resolve(here, "..", "approve-pr.sh");

const REPO = "example-org/example-repo";
const PR = 42;
const KEY = "test-test-test-test";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const comment = (sha, mac) => ({ body: `maintainer-approval: ${sha} ${mac}` });
const valid = (sha = SHA, key = KEY) => comment(sha, computeApprovalMac(key, REPO, PR, sha));
const evaluate = (over) =>
  evaluateApproval({ key: KEY, repo: REPO, pr: PR, headSha: SHA, comments: [], ...over });

describe("computeApprovalMac", () => {
  it("is HMAC-SHA256 over <repo>#<pr>@<sha> with the repository lower-cased", () => {
    const expected = crypto.createHmac("sha256", KEY).update(`${REPO}#${PR}@${SHA}`).digest("hex");
    assert.equal(computeApprovalMac(KEY, REPO, PR, SHA), expected);
    assert.equal(computeApprovalMac(KEY, "Example-Org/Example-Repo", PR, SHA), expected);
  });

  it("ignores CR/LF in the key", () => {
    assert.equal(normalizeKey("k\r\n"), "k");
    assert.equal(computeApprovalMac(`${KEY}\n`, REPO, PR, SHA), computeApprovalMac(KEY, REPO, PR, SHA));
  });

  it("depends on the key, the repository, the PR number and the commit", () => {
    const base = computeApprovalMac(KEY, REPO, PR, SHA);
    assert.notEqual(base, computeApprovalMac("other-key", REPO, PR, SHA));
    assert.notEqual(base, computeApprovalMac(KEY, "example-org/other", PR, SHA));
    assert.notEqual(base, computeApprovalMac(KEY, REPO, PR + 1, SHA));
    assert.notEqual(base, computeApprovalMac(KEY, REPO, PR, OTHER_SHA));
  });
});

describe("parseApprovalLines", () => {
  it("finds approval lines inside longer comments and ignores malformed ones", () => {
    const mac = "c".repeat(64);
    const body = [
      "some text",
      `maintainer-approval: ${SHA} ${mac}`,
      `maintainer-approval: ${SHA.slice(1)} ${mac}`,
      `maintainer-approval: ${SHA} ${mac.slice(1)}`,
      `  maintainer-approval: ${SHA} ${mac}`,
      `maintainer-approval: ${SHA.toUpperCase()} ${mac}`,
    ].join("\r\n");
    assert.deepEqual(parseApprovalLines(body), [{ sha: SHA, mac }]);
  });
});

describe("evaluateApproval", () => {
  it("valid HMAC for the current head -> success", () => {
    const r = evaluate({ comments: [valid()] });
    assert.equal(r.state, "success");
    assert.match(r.description, /approved commit aaaaaaa/);
  });

  it("finds the valid comment among unrelated and forged ones", () => {
    const forged = comment(SHA, "0".repeat(64));
    const r = evaluate({ comments: [{ body: "hello" }, forged, valid()] });
    assert.equal(r.state, "success");
  });

  it("approval for another sha -> failure that asks for a new approval", () => {
    const r = evaluate({ comments: [valid(OTHER_SHA)] });
    assert.equal(r.state, "failure");
    assert.match(r.description, /older commit/);
  });

  it("approval for the current sha signed by a valid mac of another sha is rejected", () => {
    const stolen = comment(SHA, computeApprovalMac(KEY, REPO, PR, OTHER_SHA));
    assert.equal(evaluate({ comments: [stolen] }).state, "failure");
  });

  it("approval copied from another PR is rejected", () => {
    const fromOtherPr = comment(SHA, computeApprovalMac(KEY, REPO, PR + 1, SHA));
    assert.equal(evaluate({ comments: [fromOtherPr] }).state, "failure");
  });

  it("forgery without the key -> failure", () => {
    const forged = comment(SHA, computeApprovalMac("guessed-key", REPO, PR, SHA));
    const r = evaluate({ comments: [forged] });
    assert.equal(r.state, "failure");
    assert.match(r.description, /invalid signature/);
  });

  it("no approval at all -> failure", () => {
    const r = evaluate();
    assert.equal(r.state, "failure");
    assert.match(r.description, /no maintainer approval/);
  });

  it("missing secret -> failure with a clear text, even when a comment exists", () => {
    for (const key of [undefined, "", "\n"]) {
      const r = evaluate({ key, comments: [valid()] });
      assert.equal(r.state, "failure");
      assert.match(r.description, /MAINTAINER_APPROVAL_KEY secret is not configured/);
    }
  });

  it("draft PR -> pending, not success", () => {
    const r = evaluate({ draft: true, comments: [valid()] });
    assert.equal(r.state, "pending");
  });

  it("unreadable head -> failure", () => {
    assert.equal(evaluate({ headSha: "" }).state, "failure");
    assert.equal(evaluate({ headSha: "xyz" }).state, "failure");
  });
});

// A tiny in-memory GitHub API: no network.
function fakeGithub({ head = SHA, draft = false, comments = [] }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, search: u.search, body: init.body });
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (init.method === "GET" && u.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({ head: { sha: head }, draft });
    }
    if (init.method === "GET" && u.pathname === `/repos/${REPO}/issues/${PR}/comments`) {
      return json(u.searchParams.get("page") === "1" ? comments : []);
    }
    if (init.method === "POST" && u.pathname === `/repos/${REPO}/statuses/${head}`) {
      return json({}, 201);
    }
    return json({ message: "unexpected" }, 500);
  };
  return { fetch, calls };
}

const baseEnv = (over = {}) => ({
  GITHUB_REPOSITORY: REPO,
  PR_NUMBER: String(PR),
  GH_TOKEN: "placeholder-value",
  MAINTAINER_APPROVAL_KEY: KEY,
  GITHUB_SERVER_URL: "https://github.example.com",
  GITHUB_RUN_ID: "7",
  ...over,
});

async function runMain(gh, env) {
  const logs = [];
  const result = await main(env, { fetch: gh.fetch, log: (m) => logs.push(m) });
  const post = gh.calls.find((c) => c.method === "POST");
  return { result, logs, post: post && { path: post.path, body: JSON.parse(post.body) } };
}

describe("main (workflow entry point)", () => {
  it("valid approval -> success status on the head commit", async () => {
    const gh = fakeGithub({ comments: [valid()] });
    const { post, result } = await runMain(gh, baseEnv());
    assert.equal(result.state, "success");
    assert.equal(post.path, `/repos/${REPO}/statuses/${SHA}`);
    assert.equal(post.body.state, "success");
    assert.equal(post.body.context, STATUS_CONTEXT);
    assert.equal(post.body.target_url, "https://github.example.com/example-org/example-repo/actions/runs/7");
    assert.ok(post.body.description.length <= 140);
  });

  it("approval for a previous commit after a new push -> failure", async () => {
    const gh = fakeGithub({ head: OTHER_SHA, comments: [valid(SHA)] });
    const { post } = await runMain(gh, baseEnv());
    assert.equal(post.path, `/repos/${REPO}/statuses/${OTHER_SHA}`);
    assert.equal(post.body.state, "failure");
  });

  it("forged comment -> failure", async () => {
    const gh = fakeGithub({ comments: [comment(SHA, "f".repeat(64))] });
    const { post } = await runMain(gh, baseEnv());
    assert.equal(post.body.state, "failure");
  });

  it("no secret -> failure that names the secret", async () => {
    const gh = fakeGithub({ comments: [valid()] });
    const { post } = await runMain(gh, baseEnv({ MAINTAINER_APPROVAL_KEY: "" }));
    assert.equal(post.body.state, "failure");
    assert.match(post.body.description, /MAINTAINER_APPROVAL_KEY/);
  });

  it("never prints the key or the token", async () => {
    const gh = fakeGithub({ comments: [valid()] });
    const { logs } = await runMain(gh, baseEnv());
    const all = JSON.stringify(logs);
    assert.ok(!all.includes(KEY));
    assert.ok(!all.includes("placeholder-value"));
  });

  it("does not publish anything when the API fails, and the error carries no response body", async () => {
    const fetch = async () => ({ ok: false, status: 502, json: async () => ({ message: KEY }) });
    await assert.rejects(main(baseEnv(), { fetch, log: () => {} }), (err) => {
      assert.match(err.message, /HTTP 502/);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  });

  it("rejects a malformed PR number or repository before any request", async () => {
    const gh = fakeGithub({});
    await assert.rejects(main(baseEnv({ PR_NUMBER: "1; rm -rf" }), { fetch: gh.fetch, log: () => {} }));
    await assert.rejects(main(baseEnv({ GITHUB_REPOSITORY: "no-slash" }), { fetch: gh.fetch, log: () => {} }));
    assert.equal(gh.calls.length, 0);
  });
});

// approve-pr.sh against a fake gh. bash and openssl are needed; the fake openssl wrapper records
// its arguments so the test can prove that the key never reaches a process command line.
const haveTools = spawnSync("bash", ["-c", "command -v openssl"]).status === 0;

describe("approve-pr.sh", { skip: !haveTools && "bash/openssl not available" }, () => {
  function sandbox({ state = "OPEN", head = SHA } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approve-pr-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const realOpenssl = spawnSync("bash", ["-c", "command -v openssl"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo "Example-Org/Example-Repo" ;;
  "pr view")
    case "$*" in
      *state*) echo "${state}" ;;
      *headRefOid*) echo "${head}" ;;
    esac ;;
  "pr comment") printf '%s\\n' "$5" > "${dir}/posted"; ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "openssl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/openssl-argv"
exec "${realOpenssl}" "$@"
`,
      { mode: 0o755 },
    );
    return { dir, bin };
  }

  function keyFile(dir, content, mode = 0o600) {
    const file = path.join(dir, "approval.key");
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
    return file;
  }

  function run(sb, args, env = {}) {
    return spawnSync("bash", [approveScript, ...args], {
      encoding: "utf8",
      env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.dir, ...env },
    });
  }

  const keys = {
    short: "k",
    typical: KEY,
    exactlyOneBlock: "x".repeat(64),
    longerThanBlock: "y".repeat(100),
    nonAscii: "\u043a\u043b\u044e\u0447-\u2713",
  };

  for (const [name, key] of Object.entries(keys)) {
    it(`posts a comment that the verifier accepts (${name} key, trailing newline)`, () => {
      const sb = sandbox();
      const file = keyFile(sb.dir, `${key}\n`);
      const res = run(sb, ["--dry-run", "7", file]);
      assert.equal(res.status, 0, res.stderr);
      const line = res.stdout.trim();
      const expected = computeApprovalMac(key, "example-org/example-repo", 7, SHA);
      assert.equal(line, `maintainer-approval: ${SHA} ${expected}`);
      const verdict = evaluateApproval({
        key,
        repo: "example-org/example-repo",
        pr: 7,
        headSha: SHA,
        comments: [{ body: line }],
      });
      assert.equal(verdict.state, "success");
    });
  }

  it("publishes the comment through gh pr comment", () => {
    const sb = sandbox();
    const file = keyFile(sb.dir, KEY);
    const res = run(sb, ["7"], { MYRMIDON_APPROVAL_KEY_FILE: file });
    assert.equal(res.status, 0, res.stderr);
    const posted = fs.readFileSync(path.join(sb.dir, "posted"), "utf8").trim();
    assert.equal(posted, `maintainer-approval: ${SHA} ${computeApprovalMac(KEY, "example-org/example-repo", 7, SHA)}`);
    assert.ok(!res.stdout.includes(KEY) && !res.stderr.includes(KEY));
  });

  it("never passes the key to another process on its command line", () => {
    for (const key of [KEY, "y".repeat(100)]) {
      const sb = sandbox();
      const file = keyFile(sb.dir, key);
      const res = run(sb, ["--dry-run", "7", file]);
      assert.equal(res.status, 0, res.stderr);
      const argv = fs.readFileSync(path.join(sb.dir, "openssl-argv"), "utf8");
      assert.ok(argv.length > 0);
      assert.ok(!argv.includes(key.slice(0, 8)));
      const hexKey = Buffer.from(key).toString("hex");
      assert.ok(!argv.includes(hexKey.slice(0, 16)));
    }
  });

  it("refuses a key file that is not 0600", () => {
    const sb = sandbox();
    for (const mode of [0o644, 0o640, 0o660, 0o700]) {
      const file = keyFile(sb.dir, KEY, mode);
      const res = run(sb, ["--dry-run", "7", file]);
      assert.notEqual(res.status, 0, `mode ${mode.toString(8)}`);
      assert.match(res.stderr, /mode 0600/);
      assert.ok(!res.stderr.includes(KEY));
    }
  });

  it("refuses a missing key file argument, an empty key and a closed PR", () => {
    const sb = sandbox();
    assert.notEqual(run(sb, ["7"]).status, 0);
    assert.notEqual(run(sb, ["--dry-run", "7", keyFile(sb.dir, "\n")]).status, 0);
    const closed = sandbox({ state: "MERGED" });
    const res = run(closed, ["--dry-run", "7", keyFile(closed.dir, KEY)]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /not open/);
  });

  it("rejects a malformed PR number", () => {
    const sb = sandbox();
    const res = run(sb, ["--dry-run", "7;id", keyFile(sb.dir, KEY)]);
    assert.notEqual(res.status, 0);
  });
});
