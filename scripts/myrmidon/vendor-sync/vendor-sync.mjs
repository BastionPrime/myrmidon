#!/usr/bin/env node
// Weekly vendor release sync (R2): merge the latest stable vendor tag into a
// `sync/<tag>` branch and write sync-report.md. See docs/myrmidon/vendor-sync.md.
//
// Exit codes: 0 — merged, or nothing to do; 2 — merge conflict (merge aborted,
// conflicts listed in the report); 1 — any other error.
//
// The script never pushes and never opens a PR: the bot does that after tests.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  classifyChanges,
  decideSync,
  extractPrNumbers,
  findPossiblyRemovableRows,
  isStableTag,
  parseDivergence,
  parseNameStatus,
  pickLatestStable,
  rowTouchesFile,
} from "./lib.mjs";

export const DEFAULT_VENDOR_URL = "https://github.com/paperclipai/paperclip.git";
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CONFLICT = 2;

const USAGE = `Usage: node scripts/myrmidon/vendor-sync/vendor-sync.mjs [options]

  --repo <dir>       fork checkout (default: current directory)
  --vendor <url>     vendor repository (default: ${DEFAULT_VENDOR_URL})
  --base <branch>    branch to sync into (default: main)
  --tag <tag>        sync this stable tag instead of the latest one
  --report <file>    report path (default: .git/sync-report.md)
  --no-fetch         do not fetch vendor tags (they are already local)
  -h, --help         show this help`;

export function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    vendor: DEFAULT_VENDOR_URL,
    base: "main",
    tag: null,
    report: null,
    fetch: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--repo") options.repo = next();
    else if (arg === "--vendor") options.vendor = next();
    else if (arg === "--base") options.base = next();
    else if (arg === "--tag") options.tag = next();
    else if (arg === "--report") options.report = next();
    else if (arg === "--no-fetch") options.fetch = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function makeGit(repo) {
  const run = (args, { allowFailure = false } = {}) => {
    try {
      return {
        ok: true,
        stdout: execFileSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024,
        }),
      };
    } catch (error) {
      if (!allowFailure) {
        const stderr = error.stderr?.toString().trim();
        throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
      }
      return { ok: false, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "" };
    }
  };
  const out = (args) => run(args).stdout.trim();
  const lines = (args) => out(args).split("\n").filter(Boolean);
  return { run, out, lines };
}

/**
 * Run the sync. Returns { code, outcome, tag, base, branch, reportPath, message }.
 * outcome: "nothing" | "merged" | "conflict".
 */
export function runVendorSync(options, log = console.log) {
  const repo = path.resolve(options.repo);
  const git = makeGit(repo);
  // Default: inside the git directory, so the report is never committed by accident.
  const reportPath = options.report
    ? path.resolve(repo, options.report)
    : path.resolve(repo, git.out(["rev-parse", "--git-dir"]), "sync-report.md");

  const dirty = git.out(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new Error("working tree has uncommitted changes; commit or stash them first");

  if (options.fetch) {
    // Stable release tags only; canary/nightly refs live under other prefixes.
    git.run(["fetch", "--no-tags", options.vendor, "refs/tags/v*:refs/tags/v*"]);
  }

  const allTags = git.lines(["tag", "-l", "v*"]);
  let latest;
  if (options.tag) {
    if (!isStableTag(options.tag)) throw new Error(`--tag ${options.tag} is not a stable tag (vYYYY.MDD.N)`);
    if (!allTags.includes(options.tag)) throw new Error(`tag ${options.tag} not found`);
    latest = options.tag;
  } else {
    latest = pickLatestStable(allTags);
  }
  const baseTag = pickLatestStable(git.lines(["tag", "--merged", options.base, "-l", "v*"]));

  const decision = decideSync({ latestVendorTag: latest, baseTag });
  if (decision.action === "nothing") {
    const message = `nothing to do: ${decision.reason}`;
    log(message);
    return { code: EXIT_OK, outcome: "nothing", tag: latest, base: baseTag, branch: null, reportPath: null, message };
  }
  const tag = decision.tag;
  const branch = `sync/${tag}`;

  if (git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).ok) {
    throw new Error(`branch ${branch} already exists; finish or delete the previous sync first`);
  }

  // Report inputs, computed before the merge so they do not depend on its result.
  const commits = git
    .lines(["log", "--no-merges", "--format=%H%x09%s", `${options.base}..${tag}`])
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  const prNumbers = extractPrNumbers(commits.map((c) => c.subject));
  const diffFrom = baseTag ?? git.out(["merge-base", options.base, tag]);
  const changes = parseNameStatus(git.out(["diff", "--name-status", "-M", diffFrom, tag]));
  const markedFiles = git
    .run(["grep", "-l", "--fixed-strings", "myrmidon(", options.base], { allowFailure: true })
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => line.slice(options.base.length + 1));
  const registry = git.run(["show", `${options.base}:docs/myrmidon/DIVERGENCE.md`], { allowFailure: true });
  const rows = registry.ok ? parseDivergence(registry.stdout) : [];
  const removable = findPossiblyRemovableRows(rows, { prNumbers, commitShas: commits.map((c) => c.sha) });
  const classified = classifyChanges(changes, { markedFiles });

  git.run(["checkout", "--quiet", "-b", branch, options.base]);
  const merge = git.run(["merge", "--no-ff", "--no-edit", "-m", `Merge vendor release ${tag}`, tag], {
    allowFailure: true,
  });

  let outcome = "merged";
  let conflicts = [];
  let conflictRows = [];
  if (!merge.ok) {
    conflicts = git.lines(["diff", "--name-only", "--diff-filter=U"]);
    git.run(["merge", "--abort"], { allowFailure: true });
    if (conflicts.length === 0) {
      throw new Error(`merge of ${tag} failed without conflicts: ${merge.stderr.trim()}`);
    }
    outcome = "conflict";
    conflictRows = conflicts.flatMap((file) =>
      rows.filter((row) => rowTouchesFile(row, file)).map((row) => ({ row, file })),
    );
  }

  const report = buildReport({
    tag,
    base: baseTag,
    baseBranch: options.base,
    branch,
    outcome,
    commits,
    conflicts,
    conflictRows,
    removable,
    classified,
  });
  writeFileSync(reportPath, report);

  const message =
    outcome === "merged"
      ? `merged ${tag} into ${branch}; report: ${reportPath}`
      : `conflict merging ${tag} (${conflicts.length} files); merge aborted, branch ${branch} left at ${options.base}; report: ${reportPath}`;
  log(message);
  return {
    code: outcome === "merged" ? EXIT_OK : EXIT_CONFLICT,
    outcome,
    tag,
    base: baseTag,
    branch,
    reportPath,
    conflicts,
    message,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return EXIT_ERROR;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  try {
    return runVendorSync(options).code;
  } catch (error) {
    console.error(`vendor-sync: ${error.message}`);
    return EXIT_ERROR;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
