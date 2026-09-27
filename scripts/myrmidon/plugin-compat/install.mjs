#!/usr/bin/env node
// Installs each plugin from plugins.json into its own clean directory the way
// the host does (npm install --ignore-scripts), then replaces every copy of
// @paperclipai/plugin-sdk and @paperclipai/shared with the packages built from
// this repository (pnpm pack, i.e. exactly what would be published).
//
// Usage: node scripts/myrmidon/plugin-compat/install.mjs --work <dir> [--only <name>]
// Needs network access to the npm registry. Node built-ins only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const REPO_PACKAGES = {
  "@paperclipai/shared": path.join(REPO_ROOT, "packages/shared"),
  "@paperclipai/plugin-sdk": path.join(REPO_ROOT, "packages/plugins/sdk"),
};

export function pluginSlug(name) {
  return name.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "__");
}

/** Every node_modules/<pkg> directory below root (including nested copies). */
export function findPackageCopies(root, packageName) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") {
        const candidate = path.join(full, ...packageName.split("/"));
        if (fs.existsSync(path.join(candidate, "package.json"))) found.push(candidate);
      }
      if (!entry.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return found;
}

function packRepoPackages(packDir) {
  fs.mkdirSync(packDir, { recursive: true });
  const tarballs = {};
  for (const [name, dir] of Object.entries(REPO_PACKAGES)) {
    const before = new Set(fs.readdirSync(packDir));
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    const created = fs.readdirSync(packDir).filter((f) => !before.has(f) && f.endsWith(".tgz"));
    if (created.length !== 1) throw new Error(`pnpm pack for ${name} produced ${created.length} tarballs`);
    tarballs[name] = path.join(packDir, created[0]);
  }
  return tarballs;
}

function replaceWithTarball(targetDir, tarball) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", targetDir, "--strip-components=1"]);
}

function main(argv) {
  let work = null;
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--work") work = argv[++i];
    else if (argv[i] === "--only") only = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!work) throw new Error("--work <dir> is required");
  work = path.resolve(work);
  const { plugins } = JSON.parse(fs.readFileSync(path.join(HERE, "plugins.json"), "utf8"));
  const tarballs = packRepoPackages(path.join(work, "_packs"));
  let failures = 0;
  for (const plugin of plugins) {
    if (only && plugin.name !== only) continue;
    const dir = path.join(work, pluginSlug(plugin.name));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "plugin-compat-host", private: true }));
    const spec = `${plugin.name}@${plugin.version}`;
    try {
      execFileSync("npm", ["install", spec, "--prefix", dir, "--save", "--ignore-scripts", "--no-audit", "--no-fund"], {
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 300_000,
      });
    } catch (error) {
      failures += 1;
      console.error(`::error title=plugin-compat install::${spec}: npm install failed`);
      continue;
    }
    for (const [name, tarball] of Object.entries(tarballs)) {
      for (const copy of findPackageCopies(dir, name)) {
        replaceWithTarball(copy, tarball);
        console.log(`${spec}: ${path.relative(dir, copy)} <- repository ${name}`);
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
