// scripts/myrmidon/release/release-body.mjs
//
// RELEASE-PUBLISH (the 02.10 gap): assembles the GitHub Release body for a
// myr-vX.Y.Z tag. Called by publish-github-release.sh; also a module for
// tests. Node built-ins only; the registry probe takes an injectable fetch
// so the tests never touch the network.
//
// CLI: node release-body.mjs <X.Y.Z>
//   Reads docs/myrmidon/CHANGELOG.md from the working directory, resolves
//   the component digests of the release tag, prints the body to stdout.
//   Exit 1 with a reason on stderr when the CHANGELOG section or a digest
//   is missing (a release without notes or without its images is a defect).

import fs from "node:fs";
import process from "node:process";

export const COMPONENTS = [
  { label: "board", repository: "myrmidon" },
  { label: "dockergate", repository: "myrmidon-dockergate" },
  { label: "fleetd", repository: "myrmidon-fleetd" },
  { label: "bot", repository: "myrmidon-hermes" },
];

/** The X.Y.Z a release supersedes: patch>0 -> X.Y.(Z-1), else X.(Y-1).0, else null. */
export function previousMinorPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const [, major, minor, patch] = match.map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  return null;
}

/** The `## X.Y.Z` section of the changelog (without the heading), or null. */
export function extractChangelogSection(markdown, version) {
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  const section = out.join("\n").trim();
  return section.length > 0 ? section : null;
}

const MANIFEST_ACCEPT =
  "application/vnd.oci.image.index.v1+json, " +
  "application/vnd.docker.distribution.manifest.list.v2+json, " +
  "application/vnd.docker.distribution.manifest.v2+json";

/**
 * Resolves one component's index digest for the release version tag with the
 * read-only anonymous v2 API (the same probe as check-release-support.sh,
 * without a docker daemon). Returns null when the tag is not in the registry.
 * `registryState` (a repository -> digest map, from --registry-state) serves
 * the answer without the network — the offline simulation the tests use.
 */
export async function componentDigest(repository, version, { fetchImpl = fetch, registryState = null } = {}) {
  if (registryState && Object.prototype.hasOwnProperty.call(registryState, repository)) {
    return registryState[repository] ?? null;
  }
  const scope = `repository:itkadr-git/${repository}:pull`;
  const tokenUrl = `https://ghcr.io/token?scope=${encodeURIComponent(scope)}`;
  try {
    const tokenResponse = await fetchImpl(tokenUrl);
    if (!tokenResponse.ok) return null;
    const { token } = await tokenResponse.json();
    const manifestResponse = await fetchImpl(
      `https://ghcr.io/v2/itkadr-git/${repository}/manifests/${version}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT } },
    );
    if (!manifestResponse.ok) return null;
    return manifestResponse.headers.get("docker-content-digest");
  } catch {
    return null;
  }
}

/** Digest table rows for every component; missing components are listed. */
export async function componentDigests(version, { fetchImpl = fetch, registryState = null } = {}) {
  const rows = [];
  const missing = [];
  for (const { label, repository } of COMPONENTS) {
    const digest = await componentDigest(repository, version, { fetchImpl, registryState });
    if (digest) rows.push(`| ${label} | \`ghcr.io/itkadr-git/${repository}@${digest}\` |`);
    else missing.push(label);
  }
  return { rows, missing };
}

/** The complete release body: deploy line, notes, digest table, cross-check. */
export function buildBody({ version, previous, section, digestRows }) {
  const anchor = previous
    ? `, "Upgrading from ${previous} to ${version}"`
    : "";
  const replaces = previous ?? "<previous>";
  return [
    `Myrmidon ${version} replaces ${replaces}. Deploy the board and the release component images (dockergate, fleetd) from this tag together; see [docs/myrmidon/deploy.md](docs/myrmidon/deploy.md)${anchor}.`,
    "",
    section,
    "",
    "## Component images (digests)",
    "",
    "| Component | Image (digest) |",
    "|---|---|",
    ...digestRows,
    "",
    `Cross-check: \`scripts/myrmidon/dockergate/check-release-support.sh --from-tag ${version}\` prints the same dockergate and fleetd digests (run against the live registry). A release whose components are missing is refused by \`deploy.sh\` itself before anything changes.`,
    "",
  ].join("\n");
}

/** Reads the changelog from the repo checkout (working directory). */
export function readChangelog(root = process.cwd()) {
  return fs.readFileSync(`${root}/docs/myrmidon/CHANGELOG.md`, "utf8");
}

function parseArgs(argv) {
  const args = { version: null, registryStatePath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--previous") {
      const version = argv[i + 1];
      if (!version || !/^\d+\.\d+\.\d+$/.test(version)) process.exit(2);
      const previous = previousMinorPatch(version);
      if (previous) process.stdout.write(previous);
      process.exit(0);
    }
    if (a === "--registry-state") {
      args.registryStatePath = argv[i + 1];
      i += 1;
    } else if (!args.version) {
      args.version = a;
    }
  }
  return args;
}

async function main() {
  const { version, registryStatePath } = parseArgs(process.argv.slice(2));
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: release-body.mjs [--registry-state <file>] <X.Y.Z>");
    process.exit(2);
  }
  const previous = previousMinorPatch(version);
  const section = extractChangelogSection(readChangelog(), version);
  if (!section) {
    console.error(
      `docs/myrmidon/CHANGELOG.md has no "## ${version}" section — a release without notes is a defect`,
    );
    process.exit(1);
  }
  const registryState = registryStatePath
    ? JSON.parse(fs.readFileSync(registryStatePath, "utf8"))
    : null;
  const { rows, missing } = await componentDigests(version, { registryState });
  if (missing.length > 0) {
    console.error(
      `component image digests missing from the registry for release ${version}: ${missing.join(", ")} — NOT publishing (RELEASE-GATE: the board and the components deploy from the same tag)`,
    );
    process.exit(1);
  }
  process.stdout.write(buildBody({ version, previous, section, digestRows: rows }));
}

if (process.argv[1] && process.argv[1].endsWith("release-body.mjs")) {
  await main();
}
