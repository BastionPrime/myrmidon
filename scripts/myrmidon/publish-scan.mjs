#!/usr/bin/env node
// Publish gate for bot-generated PR descriptions and issue text.
// gitleaks scans commits; this wrapper scans the prose that surrounds them
// before it is published. Bots must call this wrapper instead of posting
// directly: exit 0 means the text may be published, exit 1 means refuse.
//
// Usage:
//   node scripts/myrmidon/publish-scan.mjs --file <path>
//   cat body.md | node scripts/myrmidon/publish-scan.mjs
//
// Delegates the scanning to scan-text.mjs. stdout holds a short report:
// how many lines were scanned and how many findings of which rule types
// (counts only — finding text and values are never printed).
//
// Exit code: 0 publish allowed, 1 publish refused, 2 usage/read error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, summarizeFindings } from "./scan-text.mjs";

function readInput(argv) {
  const args = { file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.file) {
    if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);
    return { text: fs.readFileSync(args.file, "utf8"), source: args.file };
  }
  try {
    return { text: fs.readFileSync(0, "utf8"), source: "stdin" };
  } catch {
    return { text: "", source: "stdin" };
  }
}

/**
 * Scans one publishable text and returns a decision.
 * The result is data only: the wrapper prints it, the matched text stays
 * inside this module.
 */
export function scanForPublication(text) {
  const findings = scanText(text);
  return {
    allowed: findings.length === 0,
    lines: String(text ?? "").length === 0 ? 0 : String(text).split(/\r?\n/).length,
    findingCount: findings.length,
    byRule: summarizeFindings(findings),
  };
}

/**
 * CLI entry point. Returns the exit code:
 * 0 publish allowed, 1 publish refused, 2 usage/read error.
 */
export function main(argv = process.argv.slice(2), env = process.env, log = console) {
  let input;
  try {
    input = readInput(argv);
  } catch (error) {
    log.error(String(error.message ?? error));
    return 2;
  }
  const result = scanForPublication(input.text);
  const parts = result.byRule.map(({ rule, count }) => `${rule} x${count}`);
  const summary = parts.length === 0 ? "no findings" : `${result.findingCount} finding(s): ${parts.join(", ")}`;
  log.log(`publish-scan: scanned ${result.lines} line(s) from ${input.source} — ${summary}.`);
  if (result.allowed) {
    log.log("publish-scan: text is clean; publication allowed.");
    return 0;
  }
  log.error("publish-scan: publication refused — remove secrets and internal addresses from the text (docs/myrmidon/CONVENTIONS.md, section 9).");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
