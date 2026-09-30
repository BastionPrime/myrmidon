// Board self-deploy (myrmidon R5-A): reads image facts from the registry and
// GitHub without pulling layers and without a git clone on the board host.
//
// Two read-only probes feed verifyCiImage of domain.ts:
//
// - the registry: the image config and its OCI labels, the same facts
//   `docker buildx imagetools inspect <ref>` prints on the deploy host. The
//   default path talks to ghcr.io directly (anonymous token, manifest,
//   config blob — the standard OCI distribution flow); deployments whose board
//   container cannot reach ghcr.io set MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL to
//   a read-only inspect endpoint that answers `?ref=<reference>` with the same
//   `{{json .Image}}` shape;
// - GitHub: is the label commit reachable from main, and does it carry a
//   myr-v* tag? The REST API of the public repository answers both; optional
//   MYRMIDON_DEPLOY_GITHUB_HEADERS_JSON adds headers (an Authorization line
//   for a higher rate limit, for example) to every call.
//
// No secret is logged: request URLs carry only public names (repository,
// digest, commit); the header values come from settings and are never printed.

import { verifyCiImage, type ImageVerification } from "./domain.js";

export const GHCR_REPO_PATH = "itkadr-git/myrmidon";

export interface ProbeDeps {
  fetchJson?: (url: string, headers: Record<string, string> | null, timeoutMs: number) => Promise<unknown>;
  githubHeaders?: Record<string, string> | null;
  registryInspectUrl?: string | null;
  timeoutMs?: number;
}

const GH_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;

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

/**
 * The image config of a reference: its OCI labels, or null when the registry
 * does not have the image (the same "cannot be read from the registry" of
 * deploy.sh). Failures throw; the caller turns them into a refusal.
 */
export async function fetchImageLabels(reference: string, deps: ProbeDeps = {}): Promise<Record<string, string> | null> {
  const doFetch = deps.fetchJson ?? defaultFetchJson;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proxy = deps.registryInspectUrl ?? null;
  if (proxy) {
    const url = `${proxy}${proxy.includes("?") ? "&" : "?"}ref=${encodeURIComponent(reference)}`;
    return labelsFromInspectJson(await doFetch(url, null, timeoutMs));
  }
  return await ghcrLabels(reference, doFetch, timeoutMs);
}

/** Labels from an `imagetools inspect --format '{{json .Image}}'`-shaped answer. */
function labelsFromInspectJson(json: unknown): Record<string, string> | null {
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

async function ghcrLabels(
  reference: string,
  doFetch: (url: string, headers: Record<string, string> | null, timeoutMs: number) => Promise<unknown>,
  timeoutMs: number,
): Promise<Record<string, string> | null> {
  const digest = reference.split("@")[1];
  // 1. Anonymous pull token for the package (public packages need no auth).
  const tokenResponse = (await doFetch(
    `https://ghcr.io/token?${new URLSearchParams({ scope: `repository:${GHCR_REPO_PATH}:pull`, service: "ghcr.io" })}`,
    null,
    timeoutMs,
  )) as { token?: string } | null;
  const token = typeof tokenResponse === "object" && tokenResponse !== null ? tokenResponse.token : undefined;
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}` };
  // 2. The manifest by digest.
  const manifest = (await doFetch(`https://ghcr.io/v2/${GHCR_REPO_PATH}/manifests/${digest}`, {
    ...auth,
    Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
  }, timeoutMs)) as { config?: { digest?: string } } | null;
  const configDigest = manifest?.config?.digest;
  if (!configDigest) return null;
  // 3. The config blob: where OCI labels live.
  const configBlob = await doFetch(`https://ghcr.io/v2/${GHCR_REPO_PATH}/blobs/${configDigest}`, auth, timeoutMs);
  return labelsFromInspectJson(configBlob);
}

/** Is the commit reachable from main? GitHub compare: base main, head commit. */
export async function commitOnMainGithub(commit: string, deps: ProbeDeps = {}): Promise<boolean> {
  const doFetch = deps.fetchJson ?? defaultFetchJson;
  const headers = deps.githubHeaders ?? null;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const compare = (await doFetch(`/repos/${GHCR_REPO_PATH}/compare/main...${commit}`, headers, timeoutMs)) as {
    status?: string;
  } | null;
  // "ahead": main is ahead of the commit — the commit is in main's history.
  // "identical": the commit is main's head. Both mean reachable.
  return compare?.status === "ahead" || compare?.status === "identical";
}

/** myr-v* release tags that point at the commit (annotated tags carry ^{} peels). */
export async function releaseTagsAtCommitGithub(commit: string, deps: ProbeDeps = {}): Promise<string[]> {
  const doFetch = deps.fetchJson ?? defaultFetchJson;
  const headers = deps.githubHeaders ?? null;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refs = await doFetch(`/repos/${GHCR_REPO_PATH}/git/matching-refs/tags/myr-v`, headers, timeoutMs);
  if (!Array.isArray(refs)) return [];
  const names = new Set<string>();
  for (const entry of refs) {
    if (typeof entry !== "object" || entry === null) continue;
    const ref = (entry as Record<string, unknown>).ref;
    const object = (entry as Record<string, unknown>).object;
    if (typeof ref !== "string") continue;
    if (typeof object === "object" && object !== null && (object as Record<string, unknown>).sha !== commit) {
      continue;
    }
    names.add(ref.replace("refs/tags/", ""));
  }
  return [...names];
}

/**
 * Verify one reference end to end. Never throws: every failure is a refusal
 * with a reason, the way deploy.sh exits with CI_CHECK_REASON.
 */
export async function verifyImage(reference: string, deps: ProbeDeps = {}): Promise<ImageVerification> {
  let labels: Record<string, string> | null = null;
  let onMain = false;
  let tags: string[] | null = null;
  try {
    labels = await fetchImageLabels(reference, deps);
  } catch {
    labels = null;
  }
  const commit = labels?.["org.opencontainers.image.revision"] ?? "";
  if (labels && /^[0-9a-f]{40}$/.test(commit)) {
    try {
      onMain = await commitOnMainGithub(commit, deps);
    } catch {
      onMain = false;
    }
    if (!onMain) {
      try {
        tags = await releaseTagsAtCommitGithub(commit, deps);
      } catch {
        tags = [];
      }
    }
  }
  return verifyCiImage({
    reference,
    labels,
    commitOnMain: () => onMain,
    releaseTagsAtCommit: tags,
  });
}
