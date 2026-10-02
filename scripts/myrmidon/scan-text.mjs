#!/usr/bin/env node
// Scans arbitrary text (plan entries, PR bodies, issue text) for
// secret-shaped strings, internal network addresses and secret file paths,
// so they never reach the public repository. Companion to scan-diff.mjs,
// which scans diffs; this one scans whole texts. gitleaks stays the guard
// for commits — this scanner guards prose and plan/task text.
//
// Usage:
//   node scripts/myrmidon/scan-text.mjs [--file <path>]
//
// Input is the file given with --file, or stdin when no --file is passed.
// Exit code: 0 clean, 1 findings, 2 usage/read error (an unreadable input is
// an error, never a clean scan).
//
// Deployment-specific patterns (our own hosts, domains, addresses) come from
// MYRMIDON_FORBIDDEN_PATTERNS, the same list scan-diff.mjs uses: one regular
// expression per line, "#" comments allowed. Without it only the built-in
// rules run and a warning is printed.
//
// Findings are reported by rule name and line number only: the matched text
// (and the forbidden pattern itself) is never printed, so a leaked secret is
// not echoed back into logs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileForbiddenPatterns } from "./scan-diff.mjs";

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;

/** Returns the private-range label for an IPv4 string, or null. */
function privateRange(a, b) {
  if (a === 10) return "10/8";
  if (a === 172 && b >= 16 && b <= 31) return "172.16/12";
  if (a === 192 && b === 168) return "192.168/16";
  if (a === 100 && b >= 64 && b <= 127) return "100.64/10";
  return null;
}

/** One built-in rule: name plus a case-insensitive regex over a line. */
function rule(name, source, flags = "i") {
  return { name, regex: new RegExp(source, flags) };
}

// Rules mirror the self-check regex in docs/myrmidon/CONVENTIONS.md, section 9
// (secret-like key/value, private key headers, RFC 1918 and CGNAT ranges,
// plus common token prefixes and secret file paths).
const RULES = [
  rule("secret-like assignment", "(password|passwd|secret|token|api[_-]?key)[\"']?\\s*[:=]"),
  rule("private key header", "BEGIN [A-Z ]*PRIVATE KEY"),
  rule(
    "github token",
    "github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+|(?:^|[^A-Za-z0-9])gh[ousr]_[A-Za-z0-9]{20,}",
  ),
  rule("other token prefix", "(?:^|[^A-Za-z0-9])(?:pcp_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,})"),
  rule("telegram bot token", "(?<![A-Za-z0-9_])\\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])"),
  rule("credentials in URL", "://[^\\s/:@]+:[^\\s/@]+@"),
  rule(
    "secret file path",
    "(^|[\\s\"'`(])/etc/[^\\s\"']*secret|(^|[\\s\"'`(])~\\/\\.ssh\\/",
  ),
];

const RULE_BY_NAME = new Map(RULES.map((r) => [r.name, r]));

/** Rules used when scanning a line; overridable for tests. */
export function builtinRules() {
  return RULES;
}

/**
 * Scans one line of text with the given rules and forbidden patterns
 * ({ number, regex } as compiled by scan-diff.mjs).
 * Returns findings { line, rule }: no matched text and no pattern is kept.
 */
export function scanLine(text, lineNumber, rules = RULES, forbidden = []) {
  const findings = [];
  for (const { name, regex } of rules) {
    if (regex.test(text)) findings.push({ line: lineNumber, rule: name });
  }
  for (const { number, regex } of forbidden) {
    if (regex.test(text)) findings.push({ line: lineNumber, rule: `forbidden pattern #${number}` });
  }
  for (const match of text.matchAll(IPV4)) {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) continue;
    const range = privateRange(octets[0], octets[1]);
    if (range) findings.push({ line: lineNumber, rule: `private address in ${range}` });
  }
  return findings;
}

/**
 * Scans a whole text. Returns findings { line, rule } sorted by line, then
 * rule name; the matched text is intentionally not part of a finding.
 */
export function scanText(text, rules = RULES, forbidden = []) {
  const findings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    findings.push(...scanLine(line, index + 1, rules, forbidden));
  }
  return findings;
}

export function summarizeFindings(findings) {
  const byRule = new Map();
  for (const { rule } of findings) {
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }
  return [...byRule.entries()].map(([rule, count]) => ({ rule, count }));
}

const readStdinSync = () => fs.readFileSync(0, "utf8");

/**
 * Reads the text to scan. Any failure to read is an error (exit code 2):
 * a text that was not read must never count as a clean scan.
 */
function readInput(argv, readStdin = readStdinSync) {
  const args = { file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      args.file = argv[++i];
      if (!args.file) throw new Error("--file requires a path");
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.file) {
    if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);
    return fs.readFileSync(args.file, "utf8");
  }
  try {
    return readStdin();
  } catch (error) {
    throw new Error(`Cannot read stdin: ${error?.code ?? error?.message ?? error}`);
  }
}

/**
 * CLI entry point. Reads the text, scans it, prints findings without the
 * matched text and returns the exit code (0 clean, 1 findings, 2 error).
 */
export function main(argv = process.argv.slice(2), env = process.env, log = console, readStdin = readStdinSync) {
  let text;
  try {
    text = readInput(argv, readStdin);
  } catch (error) {
    log.error(String(error.message ?? error));
    return 2;
  }
  const forbidden = compileForbiddenPatterns(env.MYRMIDON_FORBIDDEN_PATTERNS);
  if (forbidden.length === 0) {
    log.log("::warning title=internal addresses::MYRMIDON_FORBIDDEN_PATTERNS is not set; forbidden-pattern check skipped");
  }
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  const findings = scanText(text, RULES, forbidden);
  log.log(`Scanned ${lines} line(s): ${findings.length} finding(s).`);
  for (const f of findings) {
    log.log(`::error line=${f.line}::${f.rule}`);
  }
  if (findings.length > 0) {
    log.error("Remove the secret or internal address from the text. Public repository rules: docs/myrmidon/CONVENTIONS.md, section 9.");
    return 1;
  }
  return 0;
}

export { RULES as rules, privateRange, RULE_BY_NAME as rulesByName };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
