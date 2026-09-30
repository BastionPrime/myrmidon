#!/usr/bin/env node
// Delta tracking for the hermes-agent pin (STACK-UPDATES input).
//
// Reads the delta registry (deltas.json), checks it against the pin in
// docker/bot-runtime/Dockerfile, finds the newest stable upstream release tag, and
// probes upstream for each delta: when the marker that the delta's fix introduces is
// already there, the delta can probably be dropped and the report says so.
//
// Usage (from the repository root, network required):
//   node scripts/myrmidon/hermes-upstream/hermes-upstream-check.mjs          # human report
//   node scripts/myrmidon/hermes-upstream/hermes-upstream-check.mjs --json   # machine output
//
// Exit codes: 0 report produced (even with droppable deltas: dropping one is a human
// decision), 1 the registry and the Dockerfile pin disagree or the registry is unusable.
// Never edits anything: the point is to raise the flag, not to move the pin.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DOCKERFILE = path.join(ROOT, "docker/bot-runtime/Dockerfile");
const REGISTRY = path.join(HERE, "deltas.json");

export const HINDSIGHT_CATALOG = "plugin-catalog/hindsight.yaml";

/** Stable release tags only: vYYYY.M.D, no -canary/-beta/-rc suffixes. */
export function stableTags(stdout, pattern) {
  const re = new RegExp(pattern);
  const tags = new Set();
  for (const line of stdout.split("\n")) {
    const m = line.match(/refs\/tags\/([^\s^]+?)(\^\{\})?$/);
    if (m && re.test(m[1])) tags.add(m[1]);
  }
  return [...tags].sort((a, b) => {
    const num = (t) => t.slice(1).split(".").map((n) => Number(n));
    const [am, ad, ap] = num(a);
    const [bm, bd, bp] = num(b);
    return am - bm || ad - bd || ap - bp;
  });
}

export function pinFromDockerfile(text) {
  const ref = text.match(/^ARG HERMES_GIT_REF=(\S+)$/m)?.[1];
  const version = text.match(/^ARG HERMES_VERSION=(\S+)$/m)?.[1];
  const sha = text.match(/^ARG HERMES_GIT_SHA=([0-9a-f]{40})$/m)?.[1];
  return { ref, version, sha };
}

export function hindsightCatalogPin(yamlText) {
  const repo = yamlText.match(/^repo:\s*(\S+)$/m)?.[1];
  const sha = yamlText.match(/^sha:\s*([0-9a-f]{40})$/m)?.[1];
  const subdir = yamlText.match(/^subdir:\s*(\S+)$/m)?.[1];
  return { repo, sha, subdir };
}

function rawUrl(repo, ref, file) {
  const slug = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return `https://raw.githubusercontent.com/${slug}/${ref}/${file}`;
}

export async function probe(delta, { fetchText }) {
  const text = await fetchText(delta.probe);
  const re = new RegExp(delta.probe.upstreamMarker);
  return { matched: re.test(text), bytes: text.length };
}

export async function run({
  root = ROOT,
  registryPath = REGISTRY,
  dockerfilePath = DOCKERFILE,
  exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
  fetchText = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.text();
  },
} = {}) {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const pin = pinFromDockerfile(dockerfile);
  if (!pin.ref || !pin.version) throw new Error("docker/bot-runtime/Dockerfile: no HERMES_GIT_REF/HERMES_VERSION");
  if (pin.ref !== registry.pinnedRef || pin.version !== registry.pinnedVersion) {
    throw new Error(
      `registry pins ${registry.pinnedRef}/${registry.pinnedVersion}, the Dockerfile pins ${pin.ref}/${pin.version} — update deltas.json with the image`,
    );
  }

  const tags = stableTags(exec("git", ["ls-remote", "--tags", registry.source]), registry.tagPattern);
  if (tags.length === 0) throw new Error(`no stable tags found at ${registry.source}`);
  const newest = tags[tags.length - 1];
  const pinIndex = tags.indexOf(pin.ref);
  const behind = pinIndex >= 0 ? tags.slice(pinIndex + 1) : [];

  let catalogPin = null;
  try {
    const catalogPath = path.join(root, HINDSIGHT_CATALOG);
    // Only present when this runs inside a hermes checkout; there it cross-checks the pin
    // the registry records instead of trusting it.
    if (fs.existsSync(catalogPath)) {
      catalogPin = hindsightCatalogPin(fs.readFileSync(catalogPath, "utf8"));
      const recorded = registry.hindsightPlugin?.pinnedSha;
      if (recorded && catalogPin.sha && catalogPin.sha !== recorded) {
        throw new Error(`plugin-catalog/hindsight.yaml pins ${catalogPin.sha}, deltas.json records ${recorded}`);
      }
    }
  } catch (exc) {
    if (String(exc.message).includes("deltas.json records")) throw exc;
    catalogPin = null;
  }

  const plugin = registry.hindsightPlugin || null;
  const results = [];
  for (const delta of registry.deltas) {
    const url =
      delta.probe.source === "hindsight-plugin"
        ? plugin?.repo
          ? rawUrl(plugin.repo, plugin.probeRef || "main", delta.probe.path)
          : null
        : rawUrl(registry.source, newest, delta.probe.path);
    let status;
    let detail = "";
    if (!url) {
      status = "unknown";
      detail = "no hindsight catalog pin found in the image tree";
    } else {
      try {
        const { matched, bytes } = await probe(delta, { fetchText: () => fetchText(url) });
        status = matched ? "droppable" : "still-needed";
        detail = `${bytes} bytes from ${url}`;
      } catch (exc) {
        status = "unknown";
        detail = String(exc.message || exc);
      }
    }
    results.push({ id: delta.id, kind: delta.kind, dropCondition: delta.dropCondition, offer: delta.offer, status, detail });
  }

  return { pin, newest, behind, results, catalogPin, pluginPin: plugin };
}

function render(report) {
  const lines = [];
  lines.push(`hermes-agent: pinned ${report.pin.ref} (${report.pin.version}), newest stable upstream ${report.newest}`);
  lines.push(
    report.behind.length === 0
      ? "pin is at the newest stable release"
      : `pin is behind: ${report.behind.join(", ")} — a new release is available`,
  );
  if (report.pluginPin?.pinnedSha) {
    lines.push(
      `hindsight plugin pin: ${report.pluginPin.pinnedSha.slice(0, 8)} (${report.pluginPin.repo}, ${report.pluginPin.subdir})` +
        (report.catalogPin?.sha ? " — matches the bundled catalog entry" : ""),
    );
  }
  lines.push("");
  for (const r of report.results) {
    const label = r.status === "droppable" ? "MAY BE DROPPABLE" : r.status === "still-needed" ? "still needed" : "unknown";
    lines.push(`[${label}] ${r.id} (${r.kind})`);
    lines.push(`  drop when: ${r.dropCondition}`);
    lines.push(`  offer: ${r.offer ?? "none offered"}`);
    lines.push(`  probe: ${r.detail}`);
    if (r.status === "droppable") lines.push("  -> verify upstream really covers it, then drop the patch and the registry row");
  }
  return lines.join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const asJson = process.argv.includes("--json");
  run()
    .then((report) => {
      process.stdout.write(asJson ? JSON.stringify(report, null, 2) + "\n" : render(report) + "\n");
    })
    .catch((exc) => {
      process.stderr.write(`hermes-upstream-check: ${exc.message || exc}\n`);
      process.exitCode = 1;
    });
}