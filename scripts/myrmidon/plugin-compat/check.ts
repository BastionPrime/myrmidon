// Plugin compatibility check: validates third-party plugins against the host
// code in this repository (manifest schema, API version, capability rules,
// minimum host version) and starts each worker over the real host RPC path
// until it answers `health`.
//
// Run from the server package so its dependencies resolve:
//   pnpm --filter @paperclipai/server exec tsx ../scripts/myrmidon/plugin-compat/check.ts \
//     [--work <dir>] [--fixtures-only] [--report <file>]
//
// --work points at the directory prepared by install.mjs. --fixtures-only
// validates the committed manifest snapshots only (no network, no workers).
// Exit code 1 when a required plugin (or any fixture) fails.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
// Relative imports: this file lives outside the server package, so bare
// workspace specifiers would not resolve from here.
import { PLUGIN_API_VERSION } from "../../../packages/shared/src/constants.js";
import type { PaperclipPluginManifestV1 } from "../../../packages/shared/src/index.js";
import { pluginManifestValidator } from "../../../server/src/services/plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "../../../server/src/services/plugin-capability-validator.js";
import { createPluginWorkerHandle } from "../../../server/src/services/plugin-worker-manager.js";
import { serverVersion } from "../../../server/src/version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface PluginEntry {
  name: string;
  version: string;
  required: boolean;
  fixture: string;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

interface PluginResult {
  name: string;
  version: string;
  required: boolean;
  source: "fixture" | "package";
  ok: boolean;
  steps: StepResult[];
}

function pluginSlug(name: string): string {
  return name.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "__");
}

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(host: string, minimum: string): boolean {
  const a = parseVersion(host);
  const b = parseVersion(minimum);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** Host-side static checks, the same ones plugin-loader runs at install time. */
export function checkManifest(raw: unknown, hostVersion: string): { steps: StepResult[]; manifest: PaperclipPluginManifestV1 | null } {
  const steps: StepResult[] = [];
  const validator = pluginManifestValidator();
  const parsed = validator.parse(raw);
  if (!parsed.success) {
    steps.push({ step: "manifest schema", ok: false, detail: parsed.errors });
    return { steps, manifest: null };
  }
  steps.push({ step: "manifest schema", ok: true });
  const manifest = parsed.manifest;
  const supported = validator.getSupportedVersions();
  steps.push({
    step: "api version",
    ok: supported.includes(manifest.apiVersion),
    detail: `plugin ${manifest.apiVersion}, host supports ${supported.join(", ")}`,
  });
  const caps = pluginCapabilityValidator().validateManifestCapabilities(manifest);
  steps.push({
    step: "capabilities",
    ok: caps.allowed,
    detail: caps.allowed ? undefined : `missing: ${caps.missing.join(", ")}`,
  });
  const minimum = manifest.minimumHostVersion ?? manifest.minimumPaperclipVersion;
  if (minimum) {
    steps.push({
      step: "minimum host version",
      ok: versionAtLeast(hostVersion, minimum),
      detail: `requires ${minimum}, host ${hostVersion}`,
    });
  }
  return { steps, manifest };
}

function resolveManifestPath(packageRoot: string, pkgJson: Record<string, unknown>): string | null {
  const declared = (pkgJson.paperclipPlugin as Record<string, unknown> | undefined)?.manifest;
  if (typeof declared === "string") return path.resolve(packageRoot, declared);
  for (const candidate of [path.join(packageRoot, "dist", "manifest.js"), path.join(packageRoot, "manifest.js")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function checkPackage(entry: PluginEntry, workDir: string, hostVersion: string): Promise<PluginResult> {
  const result: PluginResult = { name: entry.name, version: entry.version, required: entry.required, source: "package", ok: false, steps: [] };
  const packageRoot = path.join(workDir, pluginSlug(entry.name), "node_modules", ...entry.name.split("/"));
  const pkgPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    result.steps.push({ step: "installed", ok: false, detail: `${pkgPath} not found (run install.mjs)` });
    return result;
  }
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  result.steps.push({ step: "installed", ok: pkgJson.version === entry.version, detail: `version ${String(pkgJson.version)}` });

  const manifestPath = resolveManifestPath(packageRoot, pkgJson);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    result.steps.push({ step: "manifest module", ok: false, detail: "no manifest found" });
    return result;
  }
  let raw: unknown;
  try {
    const mod = (await import(pathToFileURL(manifestPath).href)) as Record<string, unknown>;
    raw = mod.default ?? mod;
    result.steps.push({ step: "manifest module", ok: true });
  } catch (error) {
    result.steps.push({ step: "manifest module", ok: false, detail: String(error) });
    return result;
  }
  const { steps, manifest } = checkManifest(raw, hostVersion);
  result.steps.push(...steps);
  if (!manifest) return result;

  const entrypoint = path.resolve(packageRoot, manifest.entrypoints.worker);
  if (!entrypoint.startsWith(packageRoot + path.sep) || !fs.existsSync(entrypoint)) {
    result.steps.push({ step: "worker entrypoint", ok: false, detail: manifest.entrypoints.worker });
    return result;
  }
  result.steps.push({ step: "worker entrypoint", ok: true });

  const handle = createPluginWorkerHandle(manifest.id, {
    entrypointPath: entrypoint,
    manifest,
    config: {},
    instanceInfo: { instanceId: "plugin-compat", hostVersion },
    apiVersion: PLUGIN_API_VERSION,
    hostHandlers: {},
    autoRestart: false,
    rpcTimeoutMs: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
  });
  try {
    await handle.start();
    result.steps.push({ step: "worker initialize", ok: true });
    const health = (await handle.call("health", {} as never, 20_000)) as { status?: string } | undefined;
    const status = health?.status ?? "unknown";
    result.steps.push({ step: "worker health", ok: status !== "error", detail: `status ${status}` });
  } catch (error) {
    result.steps.push({ step: "worker initialize", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await handle.stop().catch(() => undefined);
  }
  result.ok = result.steps.every((s) => s.ok);
  return result;
}

function checkFixture(entry: PluginEntry, hostVersion: string): PluginResult {
  const file = path.join(HERE, entry.fixture);
  const result: PluginResult = { name: entry.name, version: entry.version, required: entry.required, source: "fixture", ok: false, steps: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    result.steps.push({ step: "fixture", ok: false, detail: String(error) });
    return result;
  }
  const { steps } = checkManifest(raw, hostVersion);
  result.steps.push(...steps);
  result.ok = steps.every((s) => s.ok);
  return result;
}

function printResult(r: PluginResult): void {
  const level = r.ok ? "ok" : r.required ? "FAIL" : "WARN";
  console.log(`${level.padEnd(4)} ${r.name}@${r.version} [${r.source}]`);
  for (const s of r.steps) console.log(`       ${s.ok ? "✓" : "✗"} ${s.step}${s.detail ? ` — ${s.detail}` : ""}`);
  if (!r.ok) {
    const failed = r.steps.filter((s) => !s.ok).map((s) => s.step).join(", ");
    const kind = r.required ? "error" : "warning";
    console.log(`::${kind} title=plugin-compat ${r.name}@${r.version} (${r.source})::failed: ${failed}`);
  }
}

async function main(argv: string[]): Promise<number> {
  let workDir: string | null = null;
  let fixturesOnly = false;
  let reportPath: string | null = null;
  let hostVersion = serverVersion;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--work") workDir = path.resolve(argv[++i]!);
    else if (a === "--fixtures-only") fixturesOnly = true;
    else if (a === "--report") reportPath = path.resolve(argv[++i]!);
    else if (a === "--host-version") hostVersion = argv[++i]!;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!fixturesOnly && !workDir) throw new Error("--work <dir> is required unless --fixtures-only");
  const { plugins } = JSON.parse(fs.readFileSync(path.join(HERE, "plugins.json"), "utf8")) as { plugins: PluginEntry[] };
  console.log(`Plugin compatibility against host ${hostVersion}, plugin API ${PLUGIN_API_VERSION}`);
  const results: PluginResult[] = [];
  for (const entry of plugins) {
    results.push(checkFixture(entry, hostVersion));
    if (!fixturesOnly) results.push(await checkPackage(entry, workDir!, hostVersion));
  }
  results.forEach(printResult);
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ hostVersion, results }, null, 2));
  const blocking = results.filter((r) => !r.ok && r.required);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed, ${blocking.length} blocking failure(s).`);
  return blocking.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
