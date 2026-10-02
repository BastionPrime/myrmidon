// Stack registry (SUA): local-state collector. Everything here is read-only
// probing of what the board server process can see: its own build metadata (the
// same source /api/health uses — one truth for the board version/commit) and,
// when a Docker socket is reachable, image digests for the seeded components.
// External release data is part B and is deliberately not touched here.

import http from "node:http";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../../server-info.js";
import {
  STACK_DOCUMENT_VERSION,
  STACK_SEED,
  emptyStackDocument,
  patchEntryFromDelta,
  seedDeltasFor,
  type StackDocument,
  type StackPatchEntry,
  type StackSeedComponent,
  type StackSnapshot,
} from "./domain.js";

export const STACK_DOCKER_SOCKET_ENV = "MYRMIDON_STACK_DOCKER_SOCKET";
export const DEFAULT_STACK_DOCKER_SOCKET = "/var/run/docker.sock";

const DOCKER_API_VERSION = "v1.45";
const DOCKER_REQUEST_TIMEOUT_MS = 10_000;

export interface DockerImageInspectSummary {
  /** RepoTag with a tag, e.g. "node:24-alpine". */
  repoTag: string | null;
  digest: string | null;
  labels: Record<string, string>;
}

export type DockerImagesPort = (
  imageRef: string,
) => Promise<DockerImageInspectSummary | null>;

interface DockerHttpResponse {
  status: number;
  body: Buffer;
}

function dockerImageInspectRequest(
  socketPath: string,
  imageRef: string,
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const segment = imageRef.split("/").map(encodeURIComponent).join("/");
    const req = http.request(
      { socketPath, path: `/${DOCKER_API_VERSION}/images/${segment}/json`, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(DOCKER_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`docker image inspect ${imageRef} timed out`));
    });
    req.on("error", reject);
    req.end();
  });
}

function summarizeImageInspect(raw: string): DockerImageInspectSummary | null {
  let parsed: {
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
    Config?: { Labels?: Record<string, string> | null } | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const repoTag = (parsed.RepoTags ?? []).find((tag) => typeof tag === "string" && tag.includes(":")) ?? null;
  const digestEntry = (parsed.RepoDigests ?? []).find((entry) => typeof entry === "string" && entry.includes("@sha256:"));
  const digest = digestEntry ? digestEntry.slice(digestEntry.indexOf("@") + 1) : null;
  return { repoTag, digest, labels: parsed.Config?.Labels ?? {} };
}

/** Docker image inspect over the unix socket; null when the image is absent. */
export function dockerImagesPort(socketPath: string = DEFAULT_STACK_DOCKER_SOCKET): DockerImagesPort {
  return async (imageRef) => {
    const res = await dockerImageInspectRequest(socketPath, imageRef);
    if (res.status === 404) return null;
    if (res.status >= 400) {
      throw new Error(`docker image inspect ${imageRef} failed: ${res.status} ${res.body.toString("utf8").slice(0, 200)}`);
    }
    return summarizeImageInspect(res.body.toString("utf8"));
  };
}

function imageRefWithoutTag(ref: string): string {
  const lastSegment = ref.slice(ref.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? ref.slice(0, ref.lastIndexOf(":")) : ref;
}

async function probeDockerImages(
  seed: StackSeedComponent,
  images: DockerImagesPort,
): Promise<StackSnapshot["local"]> {
  const refs = seed.imageRefs ?? [];
  const states: StackSnapshot["local"] = {
    version: null,
    commit: null,
    digest: null,
    runningOn: null,
    unknownReason: null,
    checkedAt: null,
    patches: [],
  };
  if (refs.length === 0) {
    states.unknownReason = "no image references configured for this component";
    return states;
  }
  let found = false;
  const runningOn: string[] = [];
  for (const ref of refs) {
    // A thrown error is an infrastructure failure of the probe port itself
    // (socket unreachable, daemon error): the route turns it into a 503 so
    // the previous cache survives. A missing image (null) is a normal,
    // per-component unknown, not a failure.
    const summary = await images(imageRefWithoutTag(ref));
    if (!summary) continue;
    found = true;
    runningOn.push(summary.repoTag ?? ref);
    if (!states.version && summary.repoTag) states.version = summary.repoTag;
    if (!states.digest && summary.digest) states.digest = summary.digest;
  }
  if (found) {
    states.runningOn = runningOn.join(", ");
    return states;
  }
  states.unknownReason = "image not present on the Docker host reachable from the board";
  return states;
}

export interface CollectStackLocalOptions {
  now?: () => Date;
  /** Docker image inspect port; defaults to the unix-socket implementation. */
  images?: DockerImagesPort;
  /** Board snapshot override; defaults to the live /api/health source. */
  serverInfo?: ServerInfoSnapshot;
  /**
   * The previously stored document. Part B state (upstream release data and
   * patch-closed verdicts) is carried over by component name, so a local
   * refresh never wipes the scheduled release check.
   */
  previous?: StackDocument;
}

function carryPrevious(prev: StackSnapshot | undefined, snapshot: StackSnapshot): StackSnapshot {
  if (!prev) return snapshot;
  const patches = snapshot.local.patches.map((patch) => {
    const old = prev.local.patches.find((entry) => entry.title === patch.title);
    return old ? { ...patch, state: old.state, reason: old.reason } : patch;
  });
  return {
    ...snapshot,
    local: { ...snapshot.local, patches },
    ...(prev.upstreamState ? { upstreamState: prev.upstreamState } : {}),
    ...(prev.patchClosed ? { patchClosed: prev.patchClosed } : {}),
  };
}

/**
 * Build a fresh document from the seed: the board component carries the same
 * git commit /api/health reports, docker-image components carry the digest of
 * the image present on the host, everything else is an honest unknown with a
 * reason. The patches list starts empty (filled by part B rules).
 */
export async function collectStackLocal(options: CollectStackLocalOptions = {}): Promise<StackDocument> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const previous = options.previous;
  const images = options.images ?? dockerImagesPort(process.env[STACK_DOCKER_SOCKET_ENV]?.trim() || DEFAULT_STACK_DOCKER_SOCKET);

  const serverInfo = options.serverInfo ?? getServerInfoSnapshot();
  const boardGit = serverInfo.git;

  const components: StackSnapshot[] = [];
  for (const seed of STACK_SEED) {
    const seededPatches: StackPatchEntry[] = seedDeltasFor(seed.name).map(patchEntryFromDelta);
    const snapshot: StackSnapshot = {
      version: 1,
      name: seed.name,
      releaseSource: seed.releaseSource,
      upstream: seed.upstream,
      localProbe: seed.localProbe,
      ...(seed.note ? { note: seed.note } : {}),
      local: {
        version: null,
        commit: null,
        digest: null,
        runningOn: null,
        unknownReason: null,
        checkedAt,
        patches: seededPatches,
      },
    };
    switch (seed.localProbe) {
      case "health-commit": {
        // One truth with /api/health: the same server-info snapshot source.
        if (boardGit.available) {
          snapshot.local.commit = boardGit.fullSha;
          snapshot.local.runningOn = "board server process";
        } else {
          snapshot.local.unknownReason = `board build commit unavailable (${boardGit.unavailableReason})`;
        }
        break;
      }
      case "docker-image": {
        snapshot.local = { ...(await probeDockerImages(seed, images)), checkedAt, patches: seededPatches };
        break;
      }
      case "env": {
        snapshot.local.unknownReason = "no version override configured";
        break;
      }
      case "manual": {
        snapshot.local.unknownReason = "managed by the operator; no automatic probe";
        break;
      }
      case "none": {
        snapshot.local.unknownReason = "not visible from the board server process";
        break;
      }
      case "container-labels": {
        snapshot.local.unknownReason = "no matching container labels found";
        break;
      }
    }
    components.push(carryPrevious(previous?.components.find((c) => c.name === seed.name), snapshot));
  }
  return {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: checkedAt,
    checkedAt: options.previous?.checkedAt ?? null,
    components,
  };
}

export { emptyStackDocument };
