#!/usr/bin/env node
// Checks production dependency licenses against scripts/myrmidon/license-policy.json.
//
// Usage:
//   node scripts/myrmidon/check-licenses.mjs [--input report.json] [--policy policy.json]
//
// Without --input it runs `pnpm licenses list --prod --json` itself.
// Exit code: 0 when every package is allowed or excepted, 1 otherwise.
// No dependencies: Node built-ins only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(HERE, "license-policy.json");

/** Normalizes a license id for comparison: trims, uppercases, drops a trailing "+" alias. */
export function normalizeLicenseId(id) {
  return String(id ?? "").trim().toUpperCase();
}

/**
 * Splits an SPDX-like expression into alternatives (OR) of conjunctions (AND).
 * Parentheses are flattened; this is enough for the expressions npm packages use.
 * Returns null when the text is not an expression (e.g. "SEE LICENSE IN ...").
 */
export function parseLicenseExpression(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const tokens = raw.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const alternatives = [[]];
  let expectId = true;
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === "OR" || upper === "AND") {
      if (expectId) return null;
      if (upper === "OR") alternatives.push([]);
      expectId = true;
      continue;
    }
    if (!expectId) return null; // two ids in a row: free text, not SPDX
    if (!/^[A-Za-z0-9.+-]+$/.test(token)) return null;
    alternatives[alternatives.length - 1].push(token);
    expectId = false;
  }
  if (expectId) return null;
  return alternatives;
}

function matchesAny(id, patterns) {
  const normalized = normalizeLicenseId(id);
  return patterns.some((pattern) => {
    const p = normalizeLicenseId(pattern);
    return p.endsWith("*") ? normalized.startsWith(p.slice(0, -1)) : normalized === p;
  });
}

/**
 * Classifies one license string: "allowed", "forbidden" or "unknown".
 * An OR-expression is allowed if any alternative has only allowed ids.
 * An AND-conjunction is forbidden if any of its ids is forbidden.
 */
export function classifyLicense(license, policy) {
  const alternatives = parseLicenseExpression(license);
  if (!alternatives) return "unknown";
  let sawForbiddenOnly = true;
  for (const conj of alternatives) {
    if (conj.every((id) => matchesAny(id, policy.allowed))) return "allowed";
    if (!conj.some((id) => matchesAny(id, policy.forbidden))) sawForbiddenOnly = false;
  }
  return sawForbiddenOnly ? "forbidden" : "unknown";
}

/** Flattens `pnpm licenses list --json` output into { name, version, license } rows. */
export function flattenReport(report) {
  const rows = [];
  for (const [groupLicense, packages] of Object.entries(report ?? {})) {
    for (const pkg of packages ?? []) {
      const license = typeof pkg.license === "string" && pkg.license ? pkg.license : groupLicense;
      for (const version of pkg.versions ?? [""]) {
        rows.push({ name: pkg.name, version, license });
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return rows;
}

/**
 * Evaluates every row. An exception matches by package name and the exact
 * reported license, so a license change upstream re-triggers review.
 */
export function evaluate(report, policy) {
  const exceptions = policy.exceptions ?? [];
  const violations = [];
  const excepted = [];
  const usedExceptions = new Set();
  for (const row of flattenReport(report)) {
    const verdict = classifyLicense(row.license, policy);
    if (verdict === "allowed") continue;
    const exception = exceptions.find((e) => e.name === row.name && e.license === row.license);
    if (exception) {
      usedExceptions.add(exception);
      excepted.push({ ...row, reason: exception.reason });
      continue;
    }
    violations.push({ ...row, verdict });
  }
  const unusedExceptions = exceptions.filter((e) => !usedExceptions.has(e));
  return { violations, excepted, unusedExceptions };
}

export function validatePolicy(policy) {
  const problems = [];
  if (!Array.isArray(policy.allowed) || policy.allowed.length === 0) problems.push("allowed must be a non-empty array");
  if (!Array.isArray(policy.forbidden)) problems.push("forbidden must be an array");
  for (const [i, e] of (policy.exceptions ?? []).entries()) {
    if (!e.name || !e.license) problems.push(`exceptions[${i}] needs name and license`);
    if (!e.reason || String(e.reason).trim().length < 10) problems.push(`exceptions[${i}] (${e.name}) needs a reason`);
  }
  return problems;
}

function parseArgs(argv) {
  const args = { input: null, policy: DEFAULT_POLICY };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--policy") args.policy = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function loadReport(input) {
  if (input) return JSON.parse(fs.readFileSync(input, "utf8"));
  const out = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export function main(argv = process.argv.slice(2), log = console) {
  const args = parseArgs(argv);
  const policy = JSON.parse(fs.readFileSync(args.policy, "utf8"));
  const problems = validatePolicy(policy);
  if (problems.length > 0) {
    for (const p of problems) log.error(`policy: ${p}`);
    return 1;
  }
  const report = loadReport(args.input);
  const { violations, excepted, unusedExceptions } = evaluate(report, policy);
  const total = flattenReport(report).length;
  log.log(`Checked ${total} production packages: ${violations.length} violation(s), ${excepted.length} excepted.`);
  for (const e of excepted) log.log(`  excepted: ${e.name}@${e.version} (${e.license}) - ${e.reason}`);
  for (const e of unusedExceptions) log.log(`  note: unused exception for ${e.name} (${e.license}); remove it if the package is gone`);
  for (const v of violations) {
    log.error(`  ${v.verdict === "forbidden" ? "FORBIDDEN" : "NOT ALLOWED"}: ${v.name}@${v.version} (${v.license})`);
  }
  if (violations.length > 0) {
    log.error("License check failed. Replace the dependency or add a justified exception to scripts/myrmidon/license-policy.json.");
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
