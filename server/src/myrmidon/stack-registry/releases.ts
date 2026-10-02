// Stack registry (SUA, part B): the external release-source port and the pure
// helpers of the release check. Everything here is anonymous public GitHub REST
// (no tokens, no internal addresses) with a bounded timeout.
//
// Error contract: a transport failure (no network, DNS, timeout) is thrown and
// surfaces as a probe error the route turns into 503 with the previous cache
// intact. An HTTP error status is ordinary data: one repository gone or rate
// limited is a per-component "unknown with a reason", never "the network is
// down". See docs/myrmidon/SETTINGS.md.

import { STACK_NOTE_LINE_LIMIT, STACK_NOTE_LINE_MAX } from "./domain.js";
import type { StackReleaseNotes } from "./domain.js";

export const STACK_GITHUB_API_BASE = "https://api.github.com";
export const STACK_HTTP_TIMEOUT_MS = 10_000;

export interface StackHttpResponse {
  status: number;
  json: unknown;
}

/** A JSON GET. Throws on transport failure; returns any HTTP status as data. */
export type StackFetchJson = (url: string) => Promise<StackHttpResponse>;

export function githubJsonPort(options: { timeoutMs?: number } = {}): StackFetchJson {
  const timeoutMs = options.timeoutMs ?? STACK_HTTP_TIMEOUT_MS;
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "myrmidon-stack-registry",
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function githubListUrl(repo: string, source: "github-releases" | "github-tags", perPage: number): string {
  const kind = source === "github-tags" ? "tags" : "releases";
  return `${STACK_GITHUB_API_BASE}/repos/${repo}/${kind}?per_page=${perPage}`;
}

export function githubCompareUrl(repo: string, base: string, head: string): string {
  const encodeRef = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
  return `${STACK_GITHUB_API_BASE}/repos/${repo}/compare/${encodeRef(base)}...${encodeRef(head)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StackReleaseRecord {
  tag: string;
  publishedAt: string | null;
  body: string | null;
}

function tagPublishedAt(entry: Record<string, unknown>): string | null {
  const commit = entry.commit;
  if (!isRecord(commit)) return null;
  const committer = commit.committer;
  if (!isRecord(committer)) return null;
  return typeof committer.date === "string" ? committer.date : null;
}

/**
 * Read the list payload into ordered release records (newest first, as the API
 * returns them). Unknown shapes are skipped, never fatal.
 */
export function readReleaseList(source: "github-releases" | "github-tags", json: unknown): StackReleaseRecord[] {
  if (!Array.isArray(json)) return [];
  const records: StackReleaseRecord[] = [];
  for (const entry of json) {
    if (!isRecord(entry)) continue;
    const tag = source === "github-tags" ? entry.name : entry.tag_name;
    if (typeof tag !== "string" || tag.length === 0) continue;
    const publishedAt = source === "github-tags"
      ? tagPublishedAt(entry)
      : (typeof entry.published_at === "string" ? entry.published_at : null);
    records.push({
      tag,
      publishedAt,
      body: typeof entry.body === "string" ? entry.body : null,
    });
  }
  return records;
}

const NOTABLE_LINE = /security|vulnerab|CVE-\d{4}-\d+|breaking|deprecat|insecure|exploit/i;
const SECURITY_LINE = /security|vulnerab|CVE-\d{4}-\d+|insecure|exploit/i;

/** Trim a line and cap its length so one release note cannot fill the card. */
function shorten(line: string, max: number): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}\u2026` : collapsed;
}

/**
 * Notable release-note lines (security/breaking/CVE markers), newest releases
 * first, top-N, each line bounded. Null when there is nothing notable.
 */
export function extractReleaseNotes(
  releases: readonly StackReleaseRecord[],
  options: { limit?: number; lineMax?: number } = {},
): StackReleaseNotes | null {
  const limit = options.limit ?? STACK_NOTE_LINE_LIMIT;
  const lineMax = options.lineMax ?? STACK_NOTE_LINE_MAX;
  const lines: string[] = [];
  let truncated = false;
  let hasSecurity = false;
  for (const release of releases) {
    if (!release.body) continue;
    for (const rawLine of release.body.split(/\r?\n/)) {
      if (rawLine.includes("|")) continue; // markdown table rows carry the whole row
      if (!NOTABLE_LINE.test(rawLine)) continue;
      if (SECURITY_LINE.test(rawLine)) hasSecurity = true;
      if (lines.length >= limit) {
        truncated = true;
        continue;
      }
      lines.push(`${release.tag} — ${shorten(rawLine, lineMax)}`);
    }
  }
  if (lines.length === 0 && !hasSecurity) return null;
  return { lines, truncated, hasSecurity };
}

/**
 * Whether a known fix commit is part of the compare range. GitHub's compare
 * payload lists the commits of `base...head`; an eight-character prefix match is
 * enough for the neutral short hashes we store.
 */
export function compareContainsFix(json: unknown, fixCommits: readonly string[]): boolean {
  if (!isRecord(json) || !Array.isArray(json.commits)) return false;
  const shas = json.commits
    .filter((c): c is Record<string, unknown> => isRecord(c))
    .map((c) => (typeof c.sha === "string" ? c.sha : ""));
  return fixCommits.some((fix) => {
    const prefix = fix.slice(0, 8).toLowerCase();
    return shas.some((sha) => sha.toLowerCase().startsWith(prefix) || prefix.startsWith(sha.toLowerCase().slice(0, 8)));
  });
}

/** Normalise a local version string (image repoTag, tag, or plain version). */
export function normaliseVersion(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const afterColon = trimmed.slice(trimmed.lastIndexOf(":") + 1);
  const candidate = afterColon.includes("/") ? trimmed : afterColon;
  return candidate.replace(/^v(?=\d)/i, "").toLowerCase();
}

/**
 * Releases/tags between our version and the newest entry, or null when our
 * version is unknown or absent from the ordered list (an honest unknown: we
 * cannot prove the local version is part of this feed).
 */
export function countBehind(
  releases: readonly StackReleaseRecord[],
  localVersion: string | null,
): { latest: string | null; behindBy: number | null } {
  const latest = releases[0]?.tag ?? null;
  const ours = normaliseVersion(localVersion);
  if (!ours) return { latest, behindBy: null };
  const normalised = releases.map((release) => normaliseVersion(release.tag));
  const index = normalised.indexOf(ours);
  if (index < 0) return { latest, behindBy: null };
  return { latest, behindBy: index };
}