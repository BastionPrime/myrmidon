#!/usr/bin/env node
// Build the unpacked extension into dist-extension/.
//
// 1. tsc compiles src/*.ts to dist-extension/src/*.js (ES2022 modules,
//    exactly what the MV3 service worker and content scripts load),
// 2. the manifest and the static popup/options pages are copied alongside.
//
// No bundler step: the extension is plain ES modules, remote code is
// impossible by construction, and the reviewable source maps 1:1 to the
// loaded files.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist-extension");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "src"), { recursive: true });

const tsc = spawnSync(
  process.execPath,
  [
    path.join(here, "node_modules", "typescript", "bin", "tsc"),
    "--project",
    path.join(here, "tsconfig.build.json"),
  ],
  { stdio: "inherit" },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

for (const staticDir of ["popup", "options", "confirm"]) {
  fs.cpSync(path.join(here, staticDir), path.join(outDir, staticDir), { recursive: true });
}
fs.copyFileSync(path.join(here, "manifest.json"), path.join(outDir, "manifest.json"));

console.log(`built ${path.relative(process.cwd(), outDir)}`);
