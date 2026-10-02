// myrmidon(SUC): the client for the stack registry API.
//
// GET /api/myrmidon/stack is board-readable and returns the cached document
// (the seed view before the first refresh). POST /api/myrmidon/stack/refresh
// rebuilds the local state and POST /api/myrmidon/stack/check runs the
// external release comparison; both are instance-admin only and answer 503
// with the previous cache when a probe fails.
import { api } from "@/api/client";

export const STACK_RELEASE_SOURCES = [
  "github-releases",
  "github-tags",
  "registry",
  "package",
  "manual",
] as const;
export type StackReleaseSource = (typeof STACK_RELEASE_SOURCES)[number];

export const STACK_LOCAL_PROBES = [
  "health-commit",
  "docker-image",
  "container-labels",
  "env",
  "manual",
  "none",
] as const;
export type StackLocalProbe = (typeof STACK_LOCAL_PROBES)[number];

export type StackPatchClosedState = "closed" | "open" | "unknown";

export interface StackReleaseNotes {
  lines: string[];
  truncated: boolean;
  hasSecurity: boolean;
}

export interface StackUpstreamState {
  checkedAt: string | null;
  latest: string | null;
  latestPublishedAt: string | null;
  firstSeenAt: string | null;
  previousLatest: string | null;
  behindBy: number | null;
  notes: StackReleaseNotes | null;
  error: string | null;
}

export interface StackPatchEntry {
  title: string;
  private: boolean;
  ourVersion: string | null;
  fixCommits: string[];
  state: StackPatchClosedState;
  reason: string | null;
}

export interface StackPatchClosed {
  state: StackPatchClosedState;
  reason: string | null;
}

export interface StackComponentState {
  version: string | null;
  commit: string | null;
  digest: string | null;
  runningOn: string | null;
  unknownReason: string | null;
  checkedAt: string | null;
  patches: StackPatchEntry[];
}

export interface StackSnapshot {
  version: 1;
  name: string;
  releaseSource: StackReleaseSource;
  upstream: { kind: "github"; repo: string } | { kind: "manual" };
  localProbe: StackLocalProbe;
  note?: string;
  local: StackComponentState;
  upstreamState?: StackUpstreamState;
  patchClosed?: StackPatchClosed;
}

export interface StackDocument {
  version: 2;
  refreshedAt: string | null;
  checkedAt: string | null;
  components: StackSnapshot[];
}

export const stackQueryKey = ["myrmidon", "stack"] as const;

export const stackApi = {
  /** Read the cached registry document (the seed view before the first refresh). */
  get: () => api.get<StackDocument>("/myrmidon/stack"),
  /** Rebuild the local state from what the board process can see (instance admin). */
  refresh: () => api.post<StackDocument>("/myrmidon/stack/refresh", {}),
  /** Run the external release comparison (instance admin). */
  check: () => api.post<StackDocument>("/myrmidon/stack/check", {}),
};