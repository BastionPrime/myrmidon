#!/usr/bin/env node
// Maintainer approval lock: verifies that the current head commit of a pull request carries an
// approval comment that only the holder of the approval key can produce, and reports the result
// as a commit status with the context "maintainer approval".
//
// The approval is a PR comment line:
//
//   maintainer-approval: <sha40> <hmac-hex64>
//
// where hmac = HMAC-SHA256(key, "<owner/repo>#<pr>@<sha40>"), with the repository name lower-cased
// and the key taken from the repository secret MAINTAINER_APPROVAL_KEY (CR/LF characters removed).
// The approval is bound to one commit: a new push makes the status fail until a new comment is
// posted. Everything in a comment other than the two hex strings is ignored, and the comment
// author is deliberately not checked: authorship on GitHub cannot tell the operator from the
// development team, the key can.
//
// This script is run by a pull_request_target / issue_comment workflow. It never reads code from
// the pull request and never prints the key.

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const STATUS_CONTEXT = "maintainer approval";
export const COMMENT_PREFIX = "maintainer-approval:";
const SHA_RE = /^[0-9a-f]{40}$/;
const COMMENT_LINE_RE = /^maintainer-approval:[ \t]+([0-9a-f]{40})[ \t]+([0-9a-f]{64})[ \t]*$/;
const DESCRIPTION_LIMIT = 140;

/** Strips CR/LF so a key file or secret pasted with a trailing newline gives the same key. */
export function normalizeKey(raw) {
  return String(raw ?? "").replace(/[\r\n]/g, "");
}

/** The exact string that is signed. The repository name is lower-cased on both sides. */
export function approvalMessage(repo, pr, sha) {
  return `${String(repo).toLowerCase()}#${pr}@${String(sha).toLowerCase()}`;
}

export function computeApprovalMac(key, repo, pr, sha) {
  return crypto
    .createHmac("sha256", Buffer.from(normalizeKey(key), "utf8"))
    .update(approvalMessage(repo, pr, sha), "utf8")
    .digest("hex");
}

/** Every well-formed approval line found in a comment body. */
export function parseApprovalLines(body) {
  const found = [];
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = COMMENT_LINE_RE.exec(line);
    if (m) found.push({ sha: m[1], mac: m[2] });
  }
  return found;
}

function macEquals(expectedHex, givenHex) {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(givenHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function short(sha) {
  return String(sha).slice(0, 7);
}

/**
 * Pure decision: returns { state, description } for the status.
 * comments: array of { body } (PR conversation comments).
 */
export function evaluateApproval({ key, repo, pr, headSha, draft = false, comments = [] }) {
  const head = String(headSha ?? "").toLowerCase();
  if (!SHA_RE.test(head)) {
    return { state: "failure", description: "Cannot read the head commit of this pull request." };
  }
  const cleanKey = normalizeKey(key);
  if (cleanKey === "") {
    return {
      state: "failure",
      description: "MAINTAINER_APPROVAL_KEY secret is not configured; approval cannot be verified.",
    };
  }
  if (draft) {
    return { state: "pending", description: "Draft pull request: maintainer approval is not requested yet." };
  }

  const expected = computeApprovalMac(cleanKey, repo, pr, head);
  let sawCurrentSha = false;
  let sawOtherSha = false;
  for (const comment of comments) {
    for (const line of parseApprovalLines(comment?.body)) {
      if (line.sha !== head) {
        sawOtherSha = true;
        continue;
      }
      sawCurrentSha = true;
      if (macEquals(expected, line.mac)) {
        return { state: "success", description: `Maintainer approved commit ${short(head)}.` };
      }
    }
  }
  if (sawCurrentSha) {
    return { state: "failure", description: `Approval comment for ${short(head)} has an invalid signature.` };
  }
  if (sawOtherSha) {
    return {
      state: "failure",
      description: `Approval is for an older commit; commit ${short(head)} needs a new approval.`,
    };
  }
  return { state: "failure", description: `Commit ${short(head)} has no maintainer approval yet.` };
}

function clip(text) {
  return text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT - 3)}...`;
}

async function api(env, fetchImpl, method, path, body) {
  const base = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const res = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN || ""}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Never include the response body or headers: they are not needed and may echo request data.
    throw new Error(`GitHub API ${method} ${path.split("?")[0]} failed with HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function listComments(env, fetchImpl, repo, pr) {
  const all = [];
  for (let page = 1; page <= 50; page += 1) {
    const chunk = await api(env, fetchImpl, "GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  return all;
}

/**
 * Entry point used by the workflow. Reads env: GITHUB_REPOSITORY, PR_NUMBER, GH_TOKEN,
 * MAINTAINER_APPROVAL_KEY (may be empty), GITHUB_SERVER_URL / GITHUB_RUN_ID (optional, for the
 * status link). Returns the decision that was published.
 */
export async function main(env = process.env, { fetch: fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const repo = env.GITHUB_REPOSITORY || "";
  const pr = env.PR_NUMBER || "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is missing or malformed");
  if (!/^[1-9][0-9]{0,8}$/.test(pr)) throw new Error("PR_NUMBER is missing or malformed");

  // The head commit is always read from the API at run time, never from the event payload:
  // a comment event carries no head, and a push can land between event and run.
  const pull = await api(env, fetchImpl, "GET", `/repos/${repo}/pulls/${pr}`);
  const headSha = String(pull?.head?.sha ?? "").toLowerCase();
  const comments = await listComments(env, fetchImpl, repo, pr);

  const decision = evaluateApproval({
    key: env.MAINTAINER_APPROVAL_KEY,
    repo,
    pr,
    headSha,
    draft: pull?.draft === true,
    comments,
  });
  if (!SHA_RE.test(headSha)) throw new Error("pull request head commit is unreadable");

  const status = { state: decision.state, context: STATUS_CONTEXT, description: clip(decision.description) };
  if (env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID) {
    status.target_url = `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  await api(env, fetchImpl, "POST", `/repos/${repo}/statuses/${headSha}`, status);
  log(`${STATUS_CONTEXT}: ${decision.state} for ${short(headSha)}: ${status.description}`);
  return { ...decision, headSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : "verification failed"}`);
    process.exit(1);
  });
}
