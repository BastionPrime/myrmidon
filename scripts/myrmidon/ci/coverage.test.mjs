import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Every workspace package with test files must be run by some CI lane:
// scripts/run-vitest-stable.mjs (server + its project list), the runner lane,
// or scripts/myrmidon/ci/extra-test-lanes.json. A new package with tests that
// nothing runs fails here instead of silently never being tested.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_FILE = /\.(test|spec)\.(?:[cm]?[jt]sx?)$/;

function hasTests(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() ? hasTests(full) : TEST_FILE.test(entry.name)) return true;
  }
  return false;
}

function workspacePackageDirs() {
  const yaml = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  // The `packages:` list ends at the next top-level key.
  const afterKey = yaml.slice(yaml.indexOf("packages:") + "packages:".length);
  const nextKey = afterKey.search(/^[A-Za-z]/m);
  const block = nextKey >= 0 ? afterKey.slice(0, nextKey) : afterKey;
  const entries = [...block.matchAll(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1]);
  const globs = entries.filter((g) => !g.startsWith("!"));
  const excluded = entries.filter((g) => g.startsWith("!")).map((g) => g.slice(1).replace(/\/\*\*$/, ""));
  const isExcluded = (dir) => excluded.some((ex) => {
    const rel = path.relative(ROOT, dir).split(path.sep).join("/");
    return rel === ex || rel.startsWith(`${ex}/`);
  });
  const dirs = new Set();
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const base = path.join(ROOT, glob.slice(0, -2));
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(base, entry.name, "package.json"))) dirs.add(path.join(base, entry.name));
      }
    } else if (fs.existsSync(path.join(ROOT, glob, "package.json"))) {
      dirs.add(path.join(ROOT, glob));
    }
  }
  return [...dirs].filter((dir) => !isExcluded(dir));
}

describe("CI test coverage", () => {
  it("runs the tests of every workspace package", () => {
    const stable = fs.readFileSync(path.join(ROOT, "scripts/run-vitest-stable.mjs"), "utf8");
    const listBlock = stable.slice(stable.indexOf("const nonServerProjects = ["), stable.indexOf("];", stable.indexOf("const nonServerProjects = [")));
    const covered = new Set([...listBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    covered.add("@paperclipai/server");
    covered.add("@paperclipai/paperclip-runner"); // tests (runner) lane
    const lanes = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/myrmidon/ci/extra-test-lanes.json"), "utf8")).lanes;
    for (const lane of lanes) covered.add(lane.package);

    const missing = [];
    for (const dir of workspacePackageDirs()) {
      const name = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
      if (hasTests(dir) && !covered.has(name)) missing.push(`${name} (${path.relative(ROOT, dir)})`);
    }
    assert.deepEqual(missing, [], "add these packages to scripts/myrmidon/ci/extra-test-lanes.json");
  });

  it("lists only real packages in extra-test-lanes.json", () => {
    const names = new Set(
      workspacePackageDirs().map((dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name),
    );
    const lanes = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/myrmidon/ci/extra-test-lanes.json"), "utf8")).lanes;
    for (const lane of lanes) assert.ok(names.has(lane.package), lane.package);
  });
});
