#!/usr/bin/env node
// Scans the lines a change adds for private network addresses and for
// deployment-specific patterns that must not reach the public repository.
//
// Usage:
//   node scripts/myrmidon/scan-diff.mjs --base <sha> --head <sha> --check private-ip|forbidden
//        [--skip-tests] [--allowlist <file>] [--diff-file <file>]
//
// --check forbidden reads patterns from MYRMIDON_FORBIDDEN_PATTERNS (one
// regular expression per line, "#" comments allowed). Matches are reported by
// file, line and pattern number only: neither the pattern nor the matched text
// is printed, so the list stays private even in public CI logs.
//
// Exit code: 0 clean, 1 findings, 2 usage error. Node built-ins only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST = path.join(HERE, "scan-diff-allowlist.json");

/** Parses unified diff text into the lines it adds: { file, line, text }. */
export function parseAddedLines(diffText) {
  const added = [];
  let file = null;
  let line = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith("+")) {
      added.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith(" ")) {
      line += 1;
    }
  }
  return added;
}

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;

/** Returns the private-range label for an IPv4 string, or null. */
export function privateRange(a, b) {
  if (a === 10) return "10/8";
  if (a === 172 && b >= 16 && b <= 31) return "172.16/12";
  if (a === 192 && b === 168) return "192.168/16";
  if (a === 100 && b >= 64 && b <= 127) return "100.64/10";
  return null;
}

export function findPrivateIps(text) {
  const hits = [];
  for (const match of text.matchAll(IPV4)) {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) continue;
    const range = privateRange(octets[0], octets[1]);
    if (range) hits.push(range);
  }
  return hits;
}

/** Compiles one regex per non-empty, non-comment line; bad regexes become literal matches. */
export function compileForbiddenPatterns(text) {
  const patterns = [];
  for (const [index, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const source = raw.trim();
    if (!source || source.startsWith("#")) continue;
    let regex;
    try {
      regex = new RegExp(source, "i");
    } catch {
      regex = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    patterns.push({ number: index + 1, regex });
  }
  return patterns;
}

const TEST_PATH = /(^|\/)(__tests__|__fixtures__|fixtures|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(file) {
  return TEST_PATH.test(file);
}

function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function loadAllowlist(file) {
  if (!file || !fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return (data.privateIp ?? []).map((entry) => {
    if (!entry.path || !entry.reason) throw new Error(`allowlist entry needs path and reason: ${JSON.stringify(entry)}`);
    return { ...entry, regex: globToRegex(entry.path) };
  });
}

/**
 * Runs one check over added lines. Returns findings { file, line, rule }.
 * The matched text is intentionally not part of a finding.
 */
export function scan(addedLines, { check, patterns = [], skipTests = false, allowlist = [] }) {
  const findings = [];
  for (const { file, line, text } of addedLines) {
    if (skipTests && isTestPath(file)) continue;
    if (check === "private-ip") {
      if (allowlist.some((entry) => entry.regex.test(file))) continue;
      for (const range of findPrivateIps(text)) findings.push({ file, line, rule: `private address in ${range}` });
    } else if (check === "forbidden") {
      for (const pattern of patterns) {
        if (pattern.regex.test(text)) findings.push({ file, line, rule: `forbidden pattern #${pattern.number}` });
      }
    }
  }
  return findings;
}

function parseArgs(argv) {
  const args = { base: null, head: null, check: null, skipTests: false, allowlist: DEFAULT_ALLOWLIST, diffFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else if (a === "--check") args.check = argv[++i];
    else if (a === "--skip-tests") args.skipTests = true;
    else if (a === "--allowlist") args.allowlist = argv[++i];
    else if (a === "--diff-file") args.diffFile = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!["private-ip", "forbidden"].includes(args.check)) throw new Error("--check must be private-ip or forbidden");
  if (!args.diffFile && (!args.base || !args.head)) throw new Error("--base and --head (or --diff-file) are required");
  return args;
}

function readDiff(args) {
  if (args.diffFile) return fs.readFileSync(args.diffFile, "utf8");
  return execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", `${args.base}...${args.head}`],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
}

export function main(argv = process.argv.slice(2), env = process.env, log = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log.error(String(error.message ?? error));
    return 2;
  }
  let patterns = [];
  if (args.check === "forbidden") {
    patterns = compileForbiddenPatterns(env.MYRMIDON_FORBIDDEN_PATTERNS);
    if (patterns.length === 0) {
      log.log("::warning title=internal addresses::MYRMIDON_FORBIDDEN_PATTERNS is not set; forbidden-pattern check skipped");
      return 0;
    }
  }
  const addedLines = parseAddedLines(readDiff(args));
  const findings = scan(addedLines, {
    check: args.check,
    patterns,
    skipTests: args.skipTests,
    allowlist: args.check === "private-ip" ? loadAllowlist(args.allowlist) : [],
  });
  log.log(`Scanned ${addedLines.length} added line(s) for ${args.check}: ${findings.length} finding(s).`);
  for (const f of findings) {
    log.log(`::error file=${f.file},line=${f.line}::${f.rule}`);
  }
  if (findings.length > 0) {
    log.error("Remove the value from the change. Public repository rules: docs/myrmidon/CONVENTIONS.md, section 9.");
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
