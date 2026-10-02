// One-off host-side validation of the forked plugin manifest: the same
// checks plugin-loader runs at install time (schema, API version,
// capabilities), plus a real worker start over the host RPC path. Run from
// the server package:
//   pnpm --filter @paperclipai/server exec tsx \
//     ../scripts/myrmidon/plugin-compat/check.ts --work <dir>
// Here we reuse checkManifest only, reading the manifest module from the
// fork's built dist.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_API_VERSION } from "../../../packages/shared/src/constants.js";
import { pluginManifestValidator } from "../../../server/src/services/plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "../../../server/src/services/plugin-capability-validator.js";
import { createPluginWorkerHandle } from "../../../server/src/services/plugin-worker-manager.js";
import { serverVersion } from "../../../server/src/version.js";

const FORK_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../packages/plugins/hindsight-paperclip",
);

async function main() {
  const manifestPath = path.join(FORK_ROOT, "dist", "manifest.js");
  if (!fs.existsSync(manifestPath)) {
    console.error("manifest module missing — build the fork first (pnpm --filter @myrmidon/hindsight-paperclip build)");
    process.exit(2);
  }
  const mod = (await import(pathToFileURL(manifestPath).href)) as { default: unknown };
  const raw = mod.default;

  const validator = pluginManifestValidator();
  const parsed = validator.parse(raw);
  console.log("plugin API (host):", PLUGIN_API_VERSION, "host version:", serverVersion);
  if (!parsed.success) {
    console.error("manifest schema FAILED:", JSON.stringify(parsed.errors, null, 2));
    process.exit(1);
  }
  console.log("manifest schema: ok");
  const manifest = parsed.manifest;
  const supported = validator.getSupportedVersions();
  if (!supported.includes(manifest.apiVersion)) {
    console.error("api version FAILED:", manifest.apiVersion, "supported:", supported.join(","));
    process.exit(1);
  }
  console.log("api version: ok");
  const caps = pluginCapabilityValidator().validateManifestCapabilities(manifest);
  if (!caps.allowed) {
    console.error("capabilities FAILED: missing", caps.missing.join(","));
    process.exit(1);
  }
  console.log("capabilities: ok");
  const workerPath = path.join(FORK_ROOT, manifest.entrypoints.worker);
  if (!fs.existsSync(workerPath)) {
    console.error("worker entrypoint: MISSING");
    process.exit(1);
  }
  console.log("worker entrypoint: ok");

  const devTsxLoader = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../../cli/node_modules/tsx/dist/loader.mjs",
  );
  const handle = createPluginWorkerHandle(manifest.id, {
    entrypointPath: workerPath,
    manifest,
    config: {},
    instanceInfo: { instanceId: "plugin-compat", hostVersion: serverVersion },
    apiVersion: PLUGIN_API_VERSION,
    hostHandlers: {},
    autoRestart: false,
    rpcTimeoutMs: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
    // Dev worktrees resolve @paperclipai/shared to TS sources; the loader
    // mirrors what plugin-loader does for local-path plugins.
    ...(fs.existsSync(devTsxLoader) ? { execArgv: ["--import", devTsxLoader] } : {}),
  });
  try {
    await handle.start();
    console.log("worker initialize: ok");
    const health = (await handle.call("health", {} as never, 20_000)) as { status?: string } | undefined;
    console.log("worker health:", health?.status ?? "unknown");
    process.exit(health?.status === "ok" ? 0 : 1);
  } catch (error) {
    console.error("worker FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await handle.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
