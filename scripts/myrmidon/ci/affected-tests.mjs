#!/usr/bin/env node
// Test planning and execution for the two-tier Myrmidon CI.
//
//   node scripts/myrmidon/ci/affected-tests.mjs plan --base <sha> --head <sha> [--force-full] [--out plan.json]
//   node scripts/myrmidon/ci/affected-tests.mjs run --plan plan.json     # fast tier: selected tests
//   node scripts/myrmidon/ci/affected-tests.mjs extra                    # full tier: packages test:run skips
//
// `plan` writes `tier=<docs|fast|full>` to $GITHUB_OUTPUT when it is set.
// Vitest runs use the same isolated environment as scripts/run-vitest-stable.mjs.
// Failures listed in known-failures.json only warn. Node built-ins only.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FAST_FILES_PER_PACKAGE, classifyChanges, selectTests } from "./select.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SERVER = "@paperclipai/server";
const TEST_FILE = /\.(test|spec)\.(?:[cm]?[jt]sx?)$/;

function log(message) {
  console.log(`[affected-tests] ${message}`);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Root vitest projects (directories) from vitest.config.ts. */
export function vitestProjectDirs(root = ROOT) {
  const source = fs.readFileSync(path.join(root, "vitest.config.ts"), "utf8");
  const block = source.slice(source.indexOf("projects:"));
  return [...block.slice(0, block.indexOf("]")).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Workspace packages: { name, dir, vitestProject, scripts }. */
export function workspacePackages(root = ROOT) {
  const listed = JSON.parse(
    execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
  const projectDirs = new Set(vitestProjectDirs(root));
  return listed
    .map((entry) => {
      const dir = path.relative(root, entry.path).split(path.sep).join("/");
      const pkg = readJson(path.join(entry.path, "package.json"));
      return { name: entry.name, dir, vitestProject: projectDirs.has(dir), scripts: pkg.scripts ?? {} };
    })
    .filter((pkg) => pkg.dir !== "");
}

function walkTests(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkTests(rel, out);
    else if (TEST_FILE.test(entry.name)) out.push(rel);
  }
}

export function repoTestFiles(packages) {
  const files = [];
  for (const pkg of packages) walkTests(pkg.dir, files);
  return [...new Set(files)].map((file) => ({ file, source: fs.readFileSync(path.join(ROOT, file), "utf8") }));
}

/** Server suites scripts/run-vitest-stable.mjs runs one by one (route/authz + its explicit list). */
export function serializedServerMatcher(root = ROOT) {
  const source = fs.readFileSync(path.join(root, "scripts/run-vitest-stable.mjs"), "utf8");
  const start = source.indexOf("additionalSerializedServerTests = new Set([");
  const listed = new Set();
  if (start >= 0) {
    const block = source.slice(start, source.indexOf("]);", start));
    for (const m of block.matchAll(/"([^"]+\.test\.ts)"/g)) listed.add(m[1]);
  }
  const pattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
  return (file) => pattern.test(file) || listed.has(file);
}

// ---------------------------------------------------------------- running

const knownFailures = readJson(path.join(HERE, "known-failures.json")).failures;
const seenKnown = new Set();
const unexpected = [];

function isolatedEnv(tag) {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "pv-")));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_CONFIG: path.join(testRoot, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${tag}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  fs.mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  return { env, testRoot };
}

let invocation = 0;

/** Runs vitest with a JSON report and records failures that are not known. */
function vitest(label, args, { cwd = ROOT, exec = ["exec", "vitest"], pnpmArgs = [] } = {}) {
  invocation += 1;
  const { env, testRoot } = isolatedEnv(invocation);
  const report = path.join(testRoot, "report.json");
  log(label);
  const result = spawnSync(
    "pnpm",
    [...pnpmArgs, ...exec, "run", "--exclude", "**/dist/**", ...args, "--reporter=default", "--reporter=json", `--outputFile=${report}`],
    { cwd, env, stdio: "inherit" },
  );
  if (result.status === 0) return;
  let parsed = null;
  try {
    parsed = readJson(report);
  } catch {
    // No report: collection or startup failure.
  }
  if (!parsed) {
    unexpected.push(`${label}: vitest exited with ${result.status} and no report`);
    return;
  }
  let failedTests = 0;
  for (const suite of parsed.testResults ?? []) {
    const file = path.relative(ROOT, suite.name).split(path.sep).join("/");
    const failed = (suite.assertionResults ?? []).filter((t) => t.status === "failed");
    if (suite.status === "failed" && failed.length === 0) {
      failedTests += 1;
      const known = knownFailures.find((k) => k.file === file && k.name === "(suite failed to load)");
      if (known) {
        seenKnown.add(`${file}::${known.name}`);
        console.log(`::warning title=known vendor failure::${file} — suite failed to load`);
      } else {
        unexpected.push(`${file}: suite failed (${String(suite.message ?? "").split("\n")[0]})`);
      }
      continue;
    }
    for (const test of failed) {
      failedTests += 1;
      const name = test.fullName ?? [...(test.ancestorTitles ?? []), test.title].join(" ");
      const known = knownFailures.find((k) => k.file === file && k.name === name);
      if (known) {
        seenKnown.add(`${file}::${name}`);
        console.log(`::warning title=known vendor failure::${file} — ${name}`);
      } else {
        unexpected.push(`${file} — ${name}`);
      }
    }
  }
  // Vitest failed but the report names no failing test or suite.
  if (failedTests === 0) unexpected.push(`${label}: vitest exited with ${result.status}`);
}

function script(label, pkg, name) {
  log(label);
  const result = spawnSync("pnpm", ["--filter", pkg, "run", name], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) unexpected.push(`${label}: exit ${result.status}`);
}

function runLane(lane, pkgDir, files = []) {
  switch (lane.kind) {
    case "vitest-project":
      return vitest(`${lane.package}${files.length ? ` (${files.length} files)` : ""}`, ["--project", lane.package, ...files]);
    case "vitest-in-package": {
      const rel = files.map((f) => path.relative(pkgDir, f));
      return vitest(`${lane.package}${files.length ? ` (${files.length} files)` : ""}`, [...lane.args, ...rel], {
        cwd: path.join(ROOT, pkgDir),
      });
    }
    case "vitest-at-root":
      return vitest(lane.package, lane.args);
    case "script":
      return script(`${lane.package}: pnpm run ${lane.script}`, lane.package, lane.script);
    default:
      throw new Error(`unknown lane kind ${lane.kind}`);
  }
}

function finish() {
  for (const k of knownFailures) {
    const key = `${k.file}::${k.name}`;
    if (!seenKnown.has(key)) log(`note: known failure did not fail in this run (passed or not run): ${key}`);
  }
  if (unexpected.length > 0) {
    console.error("\nFailures:");
    for (const line of unexpected) console.error(`  ${line}`);
    return 1;
  }
  log("all selected tests passed");
  return 0;
}

// ---------------------------------------------------------------- commands

function planCommand(args) {
  const opts = { base: null, head: "HEAD", forceFull: false, out: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") opts.base = args[++i];
    else if (args[i] === "--head") opts.head = args[++i];
    else if (args[i] === "--force-full") opts.forceFull = true;
    else if (args[i] === "--out") opts.out = args[++i];
    else throw new Error(`unknown argument ${args[i]}`);
  }
  let plan;
  if (!opts.base) {
    plan = { tier: "full", reasons: ["no base commit (push or manual run)"] };
  } else {
    const changed = git(["diff", "--name-only", "--no-renames", `${opts.base}...${opts.head}`]).split("\n").filter(Boolean);
    plan = { ...classifyChanges(changed, { forceFull: opts.forceFull }), changed };
    if (plan.tier === "fast") {
      const packages = workspacePackages();
      const selection = selectTests(changed, packages, repoTestFiles(packages));
      const tooMany = selection.files.filter((entry) => entry.files.length > MAX_FAST_FILES_PER_PACKAGE);
      if (tooMany.length > 0) {
        plan = {
          tier: "full",
          reasons: tooMany.map((e) => `${e.files.length} ${e.package} test files import the change (limit ${MAX_FAST_FILES_PER_PACKAGE})`),
          changed,
        };
      } else {
        plan.selection = selection;
      }
    }
  }
  const shown = plan.reasons.slice(0, 5).join("; ") + (plan.reasons.length > 5 ? `; +${plan.reasons.length - 5} more` : "");
  log(`tier: ${plan.tier} (${shown})`);
  if (plan.selection) {
    log(`whole packages: ${plan.selection.wholePackages.join(", ") || "none"}`);
    for (const entry of plan.selection.files) log(`${entry.package}: ${entry.files.length} test file(s)`);
  }
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tier=${plan.tier}\n`);
  return 0;
}

function runCommand(args) {
  const planFile = args[args.indexOf("--plan") + 1];
  if (!planFile || args.indexOf("--plan") < 0) throw new Error("--plan <file> is required");
  const plan = readJson(planFile);
  if (plan.tier !== "fast" || !plan.selection) {
    log(`nothing to run for tier ${plan.tier}`);
    return 0;
  }
  const packages = new Map(workspacePackages().map((pkg) => [pkg.name, pkg]));
  const lanes = new Map(readJson(path.join(HERE, "extra-test-lanes.json")).lanes.map((lane) => [lane.package, lane]));
  const isSerialized = serializedServerMatcher();

  for (const name of plan.selection.wholePackages) {
    const pkg = packages.get(name);
    if (!pkg) continue;
    if (lanes.has(name)) runLane(lanes.get(name), pkg.dir);
    else if (pkg.vitestProject) vitest(`${name} (whole package)`, ["--project", name]);
    else log(`${name}: no tests configured, skipped`);
  }
  for (const entry of plan.selection.files) {
    const pkg = packages.get(entry.package);
    if (!pkg) continue;
    if (entry.package === SERVER) {
      const serialized = entry.files.filter(isSerialized);
      const general = entry.files.filter((f) => !isSerialized(f));
      if (general.length > 0) {
        vitest(`server: ${general.length} suites`, ["--project", SERVER, "--no-file-parallelism", "--maxWorkers=1", ...general]);
      }
      for (const file of serialized) vitest(`server (serialized): ${file}`, ["--project", SERVER, file, "--pool=forks", "--isolate"]);
    } else if (lanes.has(entry.package)) {
      runLane(lanes.get(entry.package), pkg.dir, entry.files);
    } else if (pkg.vitestProject) {
      vitest(`${entry.package}: ${entry.files.length} files`, ["--project", entry.package, ...entry.files]);
    }
  }
  return finish();
}

function extraCommand() {
  const packages = new Map(workspacePackages().map((pkg) => [pkg.name, pkg]));
  for (const lane of readJson(path.join(HERE, "extra-test-lanes.json")).lanes) {
    const pkg = packages.get(lane.package);
    if (!pkg) {
      unexpected.push(`${lane.package}: package not found in the workspace`);
      continue;
    }
    runLane(lane, pkg.dir);
  }
  return finish();
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "plan") return planCommand(rest);
  if (command === "run") return runCommand(rest);
  if (command === "extra") return extraCommand();
  console.error("usage: affected-tests.mjs plan|run|extra ...");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
