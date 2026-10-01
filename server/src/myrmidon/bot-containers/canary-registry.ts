// myrmidon(R5-B): reads the BOT image's facts from the registry and GitHub,
// without pulling layers and without a git clone on the board host.
//
// The same shape of probe as the board self-deploy's registry.ts (R5-A), over
// a different repository (ghcr.io/itkadr-git/myrmidon-hermes, the bot runtime
// image CI publishes). The board self-deploy's probe reads the server image of
// the same repository name path; this one reads the bot image package, so the
// two stay separate modules — deploy-jobs/registry.ts answers for
// ghcr.io/itkadr-git/myrmidon, this file for ghcr.io/itkadr-git/myrmidon-hermes.
//
// No secret is logged: request URLs carry only public names (repository,
// digest, commit); header values come from settings and are never printed.

import { verifyBotCanaryImage, type BotCanaryImageVerification } from "./canary-domain.js";

export const BOT_CANARY_REPO_PATH = "itkadr-git/myrmidon-hermes";
const GH_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BotCanaryProbeDeps {
  fetchJson?: (url: string, headers: Record<string, string> | null, timeoutMs: number) => Promise<unknown>;
  githubHeaders?: Record<string, string> | null;
  timeoutMs?: number;
}

async function defaultFetchJson(
  url: string,
  headers: Record<string, string> | null,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...(headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function labelsFromConfigBlob(json: unknown): Record<string, string> | null {
  if (typeof json !== "object" || json === null) return null;
  const config = (json as Record<string, unknown>).config ?? json;
  if (typeof config !== "object" || config === null) return null;
  const raw = (config as Record<string, unknown>).Labels ?? (config as Record<string, unknown>).labels;
  if (typeof raw !== "object" || raw === null) return null;
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") labels[key] = value;
  }
  return labels;
}

async function ghcrBotImageLabels(
  reference: string,
  doFetch: (url: string, headers: Record<string, string> | null, timeoutMs: number) => Promise<unknown>,
  timeoutMs: number,
): Promise<Record<string, string> | null> {
  const digest = reference.split("@")[1];
  // 1. Anonymous pull token for the package (public packages need no auth).
  const tokenResponse = (await doFetch(
    `https://ghcr.io/token?${new URLSearchParams({ scope: `repository:${BOT_CANARY_REPO_PATH}:pull`, service: "ghcr.io" })}`,
    null,
    timeoutMs,
  )) as { token?: string } | null;
  const token = typeof tokenResponse === "object" && tokenResponse !== null ? tokenResponse.token : undefined;
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}` };
  // 2. The manifest by digest.
  const manifest = (await doFetch(`https://ghcr.io/v2/${BOT_CANARY_REPO_PATH}/manifests/${digest}`, {
    ...auth,
    Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
  }, timeoutMs)) as { config?: { digest?: string } } | null;
  const configDigest = manifest?.config?.digest;
  if (!configDigest) return null;
  // 3. The config blob: where OCI labels live.
  const configBlob = await doFetch(`https://ghcr.io/v2/${BOT_CANARY_REPO_PATH}/blobs/${configDigest}`, auth, timeoutMs);
  return labelsFromConfigBlob(configBlob);
}

/** Is the commit reachable from main? GitHub compare: base main, head commit. */
export async function botCanaryCommitOnMainGithub(commit: string, deps: BotCanaryProbeDeps = {}): Promise<boolean> {
  const doFetch = deps.fetchJson ?? defaultFetchJson;
  const headers = deps.githubHeaders ?? null;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const compare = (await doFetch(`/repos/itkadr-git/myrmidon/compare/main...${commit}`, headers, timeoutMs)) as {
    status?: string;
  } | null;
  if (!compare || typeof compare.status !== "string") return false;
  return compare.status !== "diverged";
}

/** myr-v* release tags of the repository that point at the commit. */
export async function botCanaryReleaseTagsAtCommit(commit: string, deps: BotCanaryProbeDeps = {}): Promise<string[] | null> {
  const doFetch = deps.fetchJson ?? defaultFetchJson;
  const headers = deps.githubHeaders ?? null;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refs = (await doFetch(
    `/repos/itkadr-git/myrmidon/git/matching-refs/tags/myr-v`,
    headers,
    timeoutMs,
  )) as Array<{ ref?: string; object?: { sha?: string } }> | null;
  if (!Array.isArray(refs)) return null;
  return refs
    .filter((ref) => ref.object?.sha === commit)
    .map((ref) => (ref.ref ?? "").replace("refs/tags/", ""))
    .filter((tag) => tag.length > 0);
}

/** The full CI-image check for one bot image reference. */
export async function verifyBotCanaryImageFromRegistry(
  reference: string,
  deps: BotCanaryProbeDeps = {},
): Promise<BotCanaryImageVerification> {
  const doFetch = deps.fetchJson ?? defaultFetchJson;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let labels: Record<string, string> | null = null;
  let onMain = false;
  let tags: string[] | null = null;
  try {
    labels = await ghcrBotImageLabels(reference, doFetch, timeoutMs);
  } catch {
    labels = null;
  }
  const commit = labels?.["org.opencontainers.image.revision"] ?? "";
  if (labels && /^[0-9a-f]{40}$/.test(commit)) {
    try {
      onMain = await botCanaryCommitOnMainGithub(commit, deps);
    } catch {
      onMain = false;
    }
    if (!onMain) {
      try {
        tags = await botCanaryReleaseTagsAtCommit(commit, deps);
      } catch {
        tags = [];
      }
    }
  }
  return verifyBotCanaryImage({
    reference,
    labels,
    commitOnMain: () => onMain,
    releaseTagsAtCommit: tags,
  });
}
