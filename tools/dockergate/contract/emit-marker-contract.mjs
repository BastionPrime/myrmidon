// tools/dockergate/contract/emit-marker-contract.mjs
//
// Part of the dockergate<->driver contract (see emit-fixtures.ts). Emits the
// raw applied markers serializeAppliedMarker() produces for a matrix of
// profiles (with and without maxConcurrentRuns, several files, long values)
// into <out>/markers/ and the index marker-contract.json. The Go contract test
// (internal/ustar/marker_contract_test.go) feeds each marker through the real
// ustar.Validate path, so a marker the server writes today can never be denied
// as `tar_content/applied_json` the way the 1.3.0 incident showed. Fixtures
// are generated from server code on every run; nothing here is hand-copied.
//
// Usage (from the repository root, after `pnpm install`):
//   node tools/dockergate/contract/emit-marker-contract.mjs <out-dir>
//
// emit-fixtures.ts imports emitMarkerContract() so one emitter run produces
// the whole contract set and the CI diff covers the markers too.
//
// Implemented as .mjs run by plain node (not tsx) so it also works outside the
// server package; it compiles docker-driver.ts to a temp dir with tsc first.
// tsx is not a runtime dependency of the image, and the contract must not add
// one.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Locate the repo root (three levels up from this file: contract/dockergate/tools)
// and the server package.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const serverPkg = path.join(root, "server");

// --- the matrix ---------------------------------------------------------
// Mirrors the shapes the server really writes: a profile without a limit (old
// style), several with one, empty and long file lists, hashes of both lengths.
const BOT_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASES = [
  { id: "no-limit", profile: { botKey: BOT_KEY, restartHash: "r1", filesHash: "f1", files: [] } },
  {
    id: "limit-min",
    profile: {
      botKey: BOT_KEY,
      restartHash: "r".repeat(8),
      filesHash: "f".repeat(8),
      files: [{ path: "hermes/config.yaml", content: "model: example\n", mode: 0o644, secret: false }],
      maxConcurrentRuns: 1,
    },
  },
  {
    id: "limit-typical",
    profile: {
      botKey: BOT_KEY,
      restartHash: "r".repeat(64),
      filesHash: "f".repeat(64),
      files: [
        { path: "hermes/config.yaml", content: "model: example\n", mode: 0o644, secret: false },
        { path: "hermes/.env", content: "API_SERVER_KEY=\"placeholder\"\n", mode: 0o644, secret: true },
        { path: "workspace/AGENTS.md", content: "# Agent\n", mode: 0o644, secret: false },
      ],
      maxConcurrentRuns: 3,
    },
  },
  {
    id: "limit-max",
    profile: {
      botKey: BOT_KEY,
      restartHash: "r2",
      filesHash: "f2",
      files: [{ path: "workspace/AGENTS.md", content: "# Agent\n", mode: 0o644, secret: false }],
      maxConcurrentRuns: 50,
    },
  },
  {
    id: "limit-with-many-files",
    profile: {
      botKey: BOT_KEY,
      restartHash: "r3",
      filesHash: "f3",
      files: Array.from({ length: 60 }, (_, i) => ({
        path: `hermes/skills-board/skill-${String(i).padStart(2, "0")}/SKILL.md`,
        content: `---\nname: skill-${i}\n---\n`,
        mode: 0o644,
        secret: false,
      })),
      maxConcurrentRuns: 12,
    },
  },
];

// Compiles server/src/myrmidon/bot-containers/docker-driver.ts (and the module
// graph it reaches) to a temp dir and imports serializeAppliedMarker from the
// compiled output. The compile is cached in os.tmpdir() keyed by a hash of the
// source files, so importing this module twice in one process (the standalone
// run and the emit-fixtures.ts composition) compiles once.
let driverCache;
async function loadSerializeAppliedMarker() {
  const src = path.join(serverPkg, "src/myrmidon/bot-containers/docker-driver.ts");
  if (!fs.existsSync(src)) throw new Error(`missing ${src}`);

  // Hash every source file of the module graph: docker-driver.ts plus the
  // relative imports it actually reaches (driver.js, types.js, ustar.js —
  // anything new flows into the hash automatically).
  const graph = collectGraph(src);
  const key = crypto
    .createHash("sha256")
    .update(graph.map((f) => `${f}:${fs.statSync(f).mtimeMs}:${fs.readFileSync(f, "utf8")}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
  const cacheDir = path.join(os.tmpdir(), `marker-contract-${key}`);
  const entry = path.join(cacheDir, "myrmidon/bot-containers/docker-driver.js");
  if (!fs.existsSync(entry)) {
    // typescript's package.json exports map does not expose ./bin/tsc, so
    // require.resolve cannot find it; walk the package directory directly.
    const pkg = require.resolve("typescript/package.json", { paths: [serverPkg] });
    const tscBin = path.join(path.dirname(pkg), "bin", "tsc");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marker-contract-build-"));
    execFileSync(process.execPath, [
      tscBin,
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--types", "node",
      "--typeRoots", path.join(serverPkg, "node_modules/@types"),
      "--skipLibCheck",
      "--noEmitOnError",
      "--ignoreConfig",
      "--outDir", tmp,
      "--rootDir", path.join(serverPkg, "src"),
      src,
    ], { stdio: "inherit" });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.cpSync(tmp, cacheDir, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (driverCache && driverCache.key === key) return driverCache.fn;
  const mod = await import(entry);
  driverCache = { key, fn: mod.serializeAppliedMarker };
  return mod.serializeAppliedMarker;
}

// Walks the relative import graph of one .ts file (our own files only).
function collectGraph(entry, seen = new Set()) {
  if (seen.has(entry)) return [...seen];
  seen.add(entry);
  const text = fs.readFileSync(entry, "utf8");
  for (const m of text.matchAll(/from "\.\/([^"]+?)\.js"/g)) {
    const next = path.join(path.dirname(entry), `${m[1]}.ts`);
    if (fs.existsSync(next)) collectGraph(next, seen);
  }
  return [...seen];
}

/** Emits the marker contract set into outDir. Returns the number of markers. */
export async function emitMarkerContract(outDir) {
  const serializeAppliedMarker = await loadSerializeAppliedMarker();
  fs.mkdirSync(path.join(outDir, "markers"), { recursive: true });
  const index = [];
  for (const c of CASES) {
    const marker = serializeAppliedMarker(c.profile);
    fs.writeFileSync(path.join(outDir, "markers", `${c.id}.json`), marker);
    index.push({ id: c.id, file: `markers/${c.id}.json`, hasLimit: c.profile.maxConcurrentRuns !== undefined });
  }
  fs.writeFileSync(
    path.join(outDir, "marker-contract.json"),
    `${JSON.stringify({ index }, null, 1)}\n`,
  );
  return index.length;
}

// CLI form: node emit-marker-contract.mjs <out-dir>
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: node emit-marker-contract.mjs <out-dir>");
    process.exit(2);
  }
  const n = await emitMarkerContract(outDir);
  console.error(`emitted ${n} markers into ${outDir}`);
}
