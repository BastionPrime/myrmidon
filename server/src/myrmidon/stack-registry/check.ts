// Stack registry (SUA, part B): the release check.
//
// For every component with a GitHub release source the checker reads the
// anonymous release/tag list, records the latest upstream release, how many
// releases we are behind (when our version appears in that feed), the notable
// release-note lines and — for components with carried deltas — whether the
// upstream range already contains the fix commits (GitHub compare API). The
// result is written back into the stack cache (document schema version 2).
//
// The same function backs both triggers: the daily/manual `POST
// /api/myrmidon/stack/check` and the interval sweep mounted from the server
// entry point. A transport failure is thrown and surfaces as 503 with the
// previous cache intact; an HTTP status is recorded per component.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  STACK_CHECKABLE_RELEASE_SOURCES,
  STACK_DOCUMENT_VERSION,
  patchEntryFromDelta,
  seedDeltasFor,
  seedStackDocument,
  type StackDocument,
  type StackPatchClosed,
  type StackPatchEntry,
  type StackSnapshot,
  type StackUpstreamState,
} from "./domain.js";
import {
  compareContainsFix,
  countBehind,
  extractReleaseNotes,
  githubCompareUrl,
  githubJsonPort,
  githubListUrl,
  normaliseVersion,
  readReleaseList,
  type StackFetchJson,
} from "./releases.js";
import { readStackCheckIntervalSec } from "./settings.js";
import { readStackDocument, writeStackDocument } from "./store.js";

export const STACK_CHECK_PER_PAGE = 30;

export interface StackCheckOptions {
  now?: () => Date;
  /** Injected JSON port; defaults to the anonymous GitHub REST client. */
  fetchJson?: StackFetchJson;
  perPage?: number;
  noteLimit?: number;
}

function readOnlyUpstream(previous: StackUpstreamState | null, checkedAt: string, error: string): StackUpstreamState {
  return {
    checkedAt,
    latest: previous?.latest ?? null,
    latestPublishedAt: previous?.latestPublishedAt ?? null,
    firstSeenAt: previous?.firstSeenAt ?? null,
    previousLatest: previous?.latest ?? null,
    behindBy: previous?.behindBy ?? null,
    notes: previous?.notes ?? null,
    error,
  };
}

/** Evaluate the carried deltas of one component against the upstream range. */
async function evaluatePatches(
  component: StackSnapshot,
  latest: string | null,
  port: StackFetchJson,
  checkedAt: string,
): Promise<StackPatchEntry[]> {
  const deltas = component.local.patches.length > 0
    ? component.local.patches
    : seedDeltasFor(component.name).map(patchEntryFromDelta);
  const repo = component.upstream.kind === "github" ? component.upstream.repo : null;
  const evaluated: StackPatchEntry[] = [];
  for (const delta of deltas) {
    const base = delta.ourVersion ?? component.local.version ?? null;
    if (!repo || !latest) {
      evaluated.push({ ...delta, state: "unknown", reason: "no upstream release known yet" });
      continue;
    }
    if (!base) {
      evaluated.push({ ...delta, state: "unknown", reason: "our version is unknown" });
      continue;
    }
    if (delta.fixCommits.length === 0) {
      evaluated.push({ ...delta, state: "unknown", reason: "no upstream fix commit recorded" });
      continue;
    }
    if (normaliseVersion(base) === normaliseVersion(latest)) {
      // The range is empty: the delta was applied to the very release we carry it on.
      evaluated.push({ ...delta, state: "open", reason: "upstream latest is the version we carry the patch on" });
      continue;
    }
    const res = await port(githubCompareUrl(repo, base, latest));
    if (res.status === 404) {
      evaluated.push({ ...delta, state: "unknown", reason: "compare range unavailable for the recorded version" });
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      evaluated.push({ ...delta, state: "unknown", reason: `github compare ${res.status}` });
      continue;
    }
    if (compareContainsFix(res.json, delta.fixCommits)) {
      evaluated.push({ ...delta, state: "closed", reason: "the upstream range already contains the fix commit" });
    } else {
      evaluated.push({ ...delta, state: "open", reason: "the fix commit is not in the upstream range yet" });
    }
  }
  return evaluated;
}

function aggregatePatchClosed(patches: readonly StackPatchEntry[]): StackPatchClosed {
  if (patches.length === 0) return { state: "unknown", reason: "no carried patches recorded" };
  if (patches.some((patch) => patch.state === "unknown")) {
    return { state: "unknown", reason: "upstream range could not be fully evaluated" };
  }
  if (patches.every((patch) => patch.state === "closed")) {
    return { state: "closed", reason: `${patches.length} carried patch(es) already fixed upstream` };
  }
  return { state: "open", reason: `${patches.filter((p) => p.state === "open").length} of ${patches.length} carried patch(es) not fixed upstream yet` };
}

async function checkComponent(
  component: StackSnapshot,
  port: StackFetchJson,
  opts: Required<Pick<StackCheckOptions, "perPage">> & { noteLimit?: number },
  checkedAt: string,
): Promise<StackSnapshot> {
  if (component.upstream.kind !== "github" || !STACK_CHECKABLE_RELEASE_SOURCES.includes(component.releaseSource)) {
    return component;
  }
  const repo = component.upstream.repo;
  const source = component.releaseSource === "github-tags" ? "github-tags" : "github-releases";
  const previous = component.upstreamState ?? null;
  // A transport failure here propagates: the whole check fails and the cache
  // stays untouched (the route answers 503).
  const res = await port(githubListUrl(repo, source, opts.perPage));
  if (res.status < 200 || res.status >= 300) {
    return { ...component, upstreamState: readOnlyUpstream(previous, checkedAt, `github ${res.status}`) };
  }
  const releases = readReleaseList(source, res.json);
  const { latest, behindBy } = countBehind(releases, component.local.version ?? component.local.commit);
  const notes = source === "github-releases"
    ? extractReleaseNotes(releases, { limit: opts.noteLimit })
    : null;
  const firstSeenAt = latest && latest === previous?.latest
    ? previous?.firstSeenAt ?? checkedAt
    : latest ? checkedAt : null;
  const upstream: StackUpstreamState = {
    checkedAt,
    latest,
    latestPublishedAt: releases[0]?.publishedAt ?? null,
    firstSeenAt,
    previousLatest: previous?.latest ?? null,
    behindBy,
    notes: notes ?? (latest != null && latest === previous?.latest ? previous?.notes ?? null : null),
    error: null,
  };
  const patches = await evaluatePatches(component, latest, port, checkedAt);
  return {
    ...component,
    local: { ...component.local, patches },
    upstreamState: upstream,
    patchClosed: aggregatePatchClosed(patches),
  };
}

/**
 * Run one release check over the cached document and write the result back.
 * Throws a probe error when the network is unreachable; the caller keeps the
 * previous cache.
 */
export async function checkStackReleases(db: Db, options: StackCheckOptions = {}): Promise<StackDocument> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const port = options.fetchJson ?? githubJsonPort();
  const stored = await readStackDocument(db);
  const base = stored.components.length > 0 ? stored : seedStackDocument();
  const opts = { perPage: options.perPage ?? STACK_CHECK_PER_PAGE, noteLimit: options.noteLimit };
  const components: StackSnapshot[] = [];
  for (const component of base.components) {
    components.push(await checkComponent(component, port, opts, checkedAt));
  }
  const next: StackDocument = {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: base.refreshedAt,
    checkedAt,
    components,
  };
  await writeStackDocument(db, next);
  return next;
}

/**
 * Mount the periodic release check. Off by default (no interval configured):
 * the board touches the network only when an operator sets the interval.
 */
export function startStackCheckSweep(db: Db, options: StackCheckOptions = {}): () => void {
  const intervalSec = readStackCheckIntervalSec();
  if (intervalSec <= 0) return () => {};
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void checkStackReleases(db, options)
      .catch((err) => logger.error({ err }, "stack release check sweep failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, intervalSec * 1000);
  timer.unref?.();
  run();
  return () => clearInterval(timer);
}