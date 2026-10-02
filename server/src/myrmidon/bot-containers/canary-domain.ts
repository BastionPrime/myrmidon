// server/src/myrmidon/bot-containers/canary-domain.ts
//
// myrmidon(R5-B): the job model of a bot image rollout with a canary. Pure
// rules: no I/O and no clock reads here; callers pass `now`.
//
// A rollout is a state machine over one bot image digest
// (ghcr.io/itkadr-git/myrmidon-hermes@sha256:<64 hex>). The digest is verified
// the same way the board self-deploy verifies its own image (R5-A,
// deploy-jobs/domain.ts): reference form, registry presence, OCI labels of the
// CI workflow, commit on origin/main or a myr-v* tag. No state, flag or setting
// skips verification: a rollout never reaches the canary with an unverified
// image.
//
// The canary flow (release 1.3 item 9, "R5-B"): the new image goes to ONE bot's
// container first — health check and a smoke run — and only after the canary
// proves the image do the rest of the fleet follow, in waves. A failed canary
// leaves the other containers untouched: the rollout stops right there.
//
// R5-C (auto-rollback by health, release 1.3 item 10): with
// MYRMIDON_BOT_CANARY_AUTO_ROLLBACK on (the default) a failed rollout does
// not leave the canary (or the already rolled wave bots) on the broken image:
// every bot that received the new digest gets its card's own image applied
// back — the "local" image, the one the card pinned before the rollout — and
// the rollout ends `rolled_back` with the original failure reason kept. With
// the rollback off the rollout ends `canary_failed` / `canary_smoke_failed` /
// `failed_health` exactly as before, the canary staying on the new image for
// inspection.
//
// Design: docs/myrmidon/design/bot-canary.md.

export const BOT_CANARY_IMAGE_REPOSITORY = "ghcr.io/itkadr-git/myrmidon-hermes";
export const BOT_CANARY_IMAGE_SOURCE = "https://github.com/itkadr-git/myrmidon";

/** Digest form the rollout accepts: `sha256:<64 lowercase hex>`, optionally with the repository prefix. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export type BotCanaryStatus =
  | "pending"
  | "verifying"
  | "failed_verification"
  | "verified"
  | "canary_waiting"
  | "canary_running"
  | "canary_health_wait"
  | "canary_smoke"
  | "canary_failed"
  | "canary_smoke_failed"
  | "wave_draining"
  | "wave_applying"
  | "wave_restoring"
  | "rolling_back"
  | "succeeded"
  | "failed_health"
  | "rolled_back"
  | "aborted";

/** Statuses under which the rollout still expects progress from the server itself. */
export const BOT_CANARY_ACTIVE_STATUSES: readonly BotCanaryStatus[] = [
  "pending",
  "verifying",
  "verified",
  "canary_waiting",
  "canary_running",
  "canary_health_wait",
  "canary_smoke",
  "wave_draining",
  "wave_applying",
  "wave_restoring",
  "rolling_back",
];

export function isBotCanaryActive(status: BotCanaryStatus): boolean {
  return BOT_CANARY_ACTIVE_STATUSES.includes(status);
}

export interface BotCanaryStep {
  at: string;
  status: BotCanaryStatus;
  detail: string;
}

export interface BotCanaryJob {
  id: string;
  companyId: string;
  /** The image digest being rolled out (the full reference is BOT_CANARY_IMAGE_REPOSITORY@digest). */
  digest: string;
  /** Expected version of the new image, from its OCI label. */
  version: string | null;
  /** Commit the image was built from, from its OCI label. */
  commit: string | null;
  status: BotCanaryStatus;
  reason: string;
  startedBy: { actorType: string; actorId: string };
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  /** The bot key of the canary agent. */
  canaryBotKey: string | null;
  /** Smoke run id of the canary, when the smoke step ran. */
  smokeRunId: string | null;
  /** Bot keys of the wave currently in progress (empty before the first wave). */
  waveBotKeys: string[];
  /** Bot keys already rolled out to the new image, canary first. */
  doneBotKeys: string[];
  /**
   * Bot keys already restored to their card images by the automatic rollback
   * (R5-C). A subset of doneBotKeys: only the bots the rollback actually
   * re-applied; empty while no rollback runs.
   */
  rolledBackBotKeys: string[];
  failureReason: string | null;
  steps: BotCanaryStep[];
}

export interface BotCanaryDocument {
  version: 1;
  /** At most one job that is not terminal; see assertNoActiveBotCanary. */
  jobs: BotCanaryJob[];
  history: BotCanaryJob[];
}

export const BOT_CANARY_HISTORY_LIMIT = 20;

export function emptyBotCanaryDocument(): BotCanaryDocument {
  return { version: 1, jobs: [], history: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUSES: readonly BotCanaryStatus[] = [
  "pending",
  "verifying",
  "failed_verification",
  "verified",
  "canary_waiting",
  "canary_running",
  "canary_health_wait",
  "canary_smoke",
  "canary_failed",
  "canary_smoke_failed",
  "wave_draining",
  "wave_applying",
  "wave_restoring",
  "rolling_back",
  "succeeded",
  "failed_health",
  "rolled_back",
  "aborted",
];

function parseStep(raw: unknown): BotCanaryStep | null {
  if (!isRecord(raw) || typeof raw.at !== "string" || typeof raw.status !== "string" || !STATUSES.includes(raw.status as BotCanaryStatus)) {
    return null;
  }
  return { at: raw.at, status: raw.status as BotCanaryStatus, detail: typeof raw.detail === "string" ? raw.detail : "" };
}

function parseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/** Read the stored document defensively: anything malformed drops out. */
export function parseBotCanaryDocument(raw: unknown): BotCanaryDocument {
  if (!isRecord(raw) || !Array.isArray(raw.jobs)) return emptyBotCanaryDocument();
  const jobs: BotCanaryJob[] = [];
  for (const item of raw.jobs) {
    const job = parseJob(item);
    if (job) jobs.push(job);
  }
  const history: BotCanaryJob[] = [];
  if (Array.isArray(raw.history)) {
    for (const item of raw.history) {
      const job = parseJob(item);
      if (job) history.push(job);
    }
  }
  return { version: 1, jobs, history };
}

function parseJob(raw: unknown): BotCanaryJob | null {
  if (!isRecord(raw)) return null;
  const status = typeof raw.status === "string" && STATUSES.includes(raw.status as BotCanaryStatus)
    ? (raw.status as BotCanaryStatus)
    : null;
  if (!status) return null;
  if (typeof raw.id !== "string" || typeof raw.digest !== "string") return null;
  const steps: BotCanaryStep[] = [];
  if (Array.isArray(raw.steps)) {
    for (const item of raw.steps) {
      const step = parseStep(item);
      if (step) steps.push(step);
    }
  }
  return {
    id: raw.id,
    companyId: typeof raw.companyId === "string" ? raw.companyId : "",
    digest: raw.digest,
    version: typeof raw.version === "string" ? raw.version : null,
    commit: typeof raw.commit === "string" ? raw.commit : null,
    status,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    startedBy: isRecord(raw.startedBy)
      ? { actorType: typeof raw.startedBy.actorType === "string" ? raw.startedBy.actorType : "", actorId: typeof raw.startedBy.actorId === "string" ? raw.startedBy.actorId : "" }
      : { actorType: "", actorId: "" },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    verifiedAt: typeof raw.verifiedAt === "string" ? raw.verifiedAt : null,
    canaryBotKey: typeof raw.canaryBotKey === "string" ? raw.canaryBotKey : null,
    smokeRunId: typeof raw.smokeRunId === "string" ? raw.smokeRunId : null,
    waveBotKeys: parseStringList(raw.waveBotKeys),
    doneBotKeys: parseStringList(raw.doneBotKeys),
    rolledBackBotKeys: parseStringList(raw.rolledBackBotKeys),
    failureReason: typeof raw.failureReason === "string" ? raw.failureReason : null,
    steps,
  };
}

/** Why `reference` is not a digest reference this module accepts, or null when it is. */
export function botCanaryReferenceProblem(reference: string): string | null {
  const trimmed = (reference ?? "").trim();
  if (!trimmed) return "no image reference given";
  if (trimmed.includes("@") && !trimmed.startsWith(`${BOT_CANARY_IMAGE_REPOSITORY}@`)) {
    return `'${trimmed.slice(0, trimmed.indexOf("@") + 1)}…' is not ${BOT_CANARY_IMAGE_REPOSITORY}: only bot runtime images built by CI are rolled out`;
  }
  const digest = trimmed.includes("@") ? trimmed.slice(trimmed.lastIndexOf("@") + 1) : trimmed;
  if (!digest.startsWith("sha256:")) {
    return "the reference must be a digest (sha256:<64 hex>), not a tag: a tag can be moved, and the canary must pin the exact image CI built";
  }
  if (!DIGEST_RE.test(digest)) {
    return "digest must be sha256: followed by 64 lowercase hex characters";
  }
  return null;
}

/** The digest of a full reference or of a bare digest, or null when invalid. */
export function parseBotCanaryDigest(reference: string): string | null {
  if (typeof reference !== "string") return null;
  if (botCanaryReferenceProblem(reference) !== null) return null;
  const at = reference.trim().lastIndexOf("@");
  return at === -1 ? reference.trim() : reference.trim().slice(at + 1);
}

export interface BotCanaryImageVerification {
  ok: boolean;
  digest: string | null;
  version: string | null;
  commit: string | null;
  reason: string | null;
}

/**
 * The CI-image check for one bot image reference, from facts the caller fetched
 * (registry labels, GitHub reachability of the commit). The rules are the ones
 * the board self-deploy (R5-A) and the deploy script apply to their image:
 *
 * 1. the reference is exactly `<repo>@sha256:<64 hex>`;
 * 2. the image is in the registry (a fetched label set exists);
 * 3. `org.opencontainers.image.revision` is a full commit sha and
 *    `org.opencontainers.image.source` equals our repository;
 * 4. that commit is on origin/main or carries a myr-v* release tag.
 */
export function verifyBotCanaryImage(input: {
  reference: string;
  labels: Record<string, string> | null;
  /** Is the label commit reachable from origin/main (GitHub said so)? */
  commitOnMain: (commit: string) => boolean;
  /** Release tags of the repository that point at the commit. */
  releaseTagsAtCommit: string[] | null;
}): BotCanaryImageVerification {
  const problem = botCanaryReferenceProblem(input.reference);
  if (problem) return { ok: false, digest: null, version: null, commit: null, reason: problem };
  const digest = parseBotCanaryDigest(input.reference)!;

  if (!input.labels) {
    return {
      ok: false,
      digest,
      version: null,
      commit: null,
      reason: `${BOT_CANARY_IMAGE_REPOSITORY}@${digest} cannot be read from the registry (never pushed there, deleted, or the registry is unreachable)`,
    };
  }
  const commit = input.labels["org.opencontainers.image.revision"] ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return {
      ok: false,
      digest,
      version: null,
      commit: null,
      reason: `${BOT_CANARY_IMAGE_REPOSITORY}@${digest} has no org.opencontainers.image.revision label with a full commit sha, so it was not built by the bot image workflow`,
    };
  }
  const source = input.labels["org.opencontainers.image.source"] ?? "";
  if (source !== BOT_CANARY_IMAGE_SOURCE) {
    return {
      ok: false,
      digest,
      version: null,
      commit,
      reason: `${BOT_CANARY_IMAGE_REPOSITORY}@${digest} has org.opencontainers.image.source '${source || "<none>"}', expected ${BOT_CANARY_IMAGE_SOURCE}: it was not built by the bot image workflow`,
    };
  }
  const onMain = input.commitOnMain(commit);
  const tags = input.releaseTagsAtCommit ?? [];
  const tagged = tags.some((tag) => /^myr-v\d+\.\d+\.\d+$/.test(tag));
  if (!onMain && !tagged) {
    return {
      ok: false,
      digest,
      version: input.labels["org.opencontainers.image.version"] ?? null,
      commit,
      reason: `commit ${commit.slice(0, 12)} of the image is neither on origin/main nor tagged myr-v*: it was built from a branch or from code that never went through a PR`,
    };
  }
  return { ok: true, digest, version: input.labels["org.opencontainers.image.version"] ?? null, commit, reason: null };
}

/** Append a step to a job, bounded so a runaway loop cannot grow the row forever. */
export function appendBotCanaryStep(job: BotCanaryJob, status: BotCanaryStatus, detail: string, now: Date): BotCanaryJob {
  const steps = [...job.steps, { at: now.toISOString(), status, detail }].slice(-100);
  return { ...job, steps };
}

/** Move a finished job to history, newest first, bounded. */
export function retireBotCanaryJob(doc: BotCanaryDocument, jobId: string, now: Date): BotCanaryDocument {
  const job = doc.jobs.find((j) => j.id === jobId);
  if (!job) return doc;
  return {
    version: 1,
    jobs: doc.jobs.filter((j) => j.id !== jobId),
    history: [{ ...job, updatedAt: now.toISOString() }, ...doc.history].slice(0, BOT_CANARY_HISTORY_LIMIT),
  };
}

export function newBotCanaryJob(input: {
  id: string;
  companyId: string;
  digest: string;
  canaryBotKey: string;
  reason: string;
  startedBy: { actorType: string; actorId: string };
  now: Date;
}): BotCanaryJob {
  const createdAt = input.now.toISOString();
  return {
    id: input.id,
    companyId: input.companyId,
    digest: input.digest,
    version: null,
    commit: null,
    status: "pending",
    reason: input.reason,
    startedBy: input.startedBy,
    createdAt,
    updatedAt: createdAt,
    verifiedAt: null,
    canaryBotKey: input.canaryBotKey,
    smokeRunId: null,
    waveBotKeys: [],
    doneBotKeys: [],
    rolledBackBotKeys: [],
    failureReason: null,
    steps: [{ at: createdAt, status: "pending", detail: "rollout created" }],
  };
}

export class BotCanaryConflict extends Error {
  readonly conflictStatus = 409;
}

/**
 * May a new rollout start, given the open jobs? At most one rollout that is
 * not terminal may exist: a second rollout while one is in flight is a request
 * conflict (409), not a queue. The canary bot runs one image change at a time.
 */
export function assertNoActiveBotCanary(doc: BotCanaryDocument): void {
  const active = doc.jobs.filter((j) => isBotCanaryActive(j.status));
  if (active.length > 0) {
    throw new BotCanaryConflict(
      `a rollout of ${BOT_CANARY_IMAGE_REPOSITORY}@${active[0].digest.slice(0, 19)} is already in progress (status ${active[0].status}); wait for it to finish or abort it`,
    );
  }
}

/**
 * Whether the rollout may be aborted right now: before the canary starts the
 * image switch (canary_running) anything is cancellable; once the canary's
 * container is being recreated the operator's tool is the rollback (R5-C),
 * not an abort.
 */
export function isBotCanaryAbortable(job: BotCanaryJob): boolean {
  return ["pending", "verifying", "verified", "canary_waiting"].includes(job.status);
}

/**
 * The bot keys the automatic rollback (R5-C) must restore: everyone who
 * received the rollout's image — the canary once its switch started (the
 * statuses from canary_running on), then the wave bots that were applied
 * before the failure (doneBotKeys). Bots never touched are not in it.
 */
export function botCanaryRollbackTargets(job: BotCanaryJob): string[] {
  const targets = [...job.doneBotKeys];
  const canarySwitched = CANARY_SWITCHED_STATUSES.includes(job.status);
  if (canarySwitched && job.canaryBotKey && !targets.includes(job.canaryBotKey)) {
    targets.unshift(job.canaryBotKey);
  }
  return targets;
}

/**
 * Statuses under which the canary's container has already been (re)created
 * with the rollout image: from canary_running on the switch happened, whether
 * the rollout later failed at health, smoke or a wave. canary_waiting is
 * absent on purpose: a deferred apply changed nothing.
 */
const CANARY_SWITCHED_STATUSES: readonly BotCanaryStatus[] = [
  "canary_running",
  "canary_health_wait",
  "canary_smoke",
  "wave_draining",
  "wave_applying",
  "wave_restoring",
  "rolling_back",
];

/**
 * Split `remaining` bot keys into the next wave and the rest. The wave size is
 * the caller's (settings read it; the default mirrors the reconciler's own
 * concurrency bound of 4, so a wave never claims more memory headroom than a
 * regular sweep pass).
 */
export function planNextBotCanaryWave(remaining: readonly string[], waveSize: number): { wave: string[]; rest: string[] } {
  if (!Number.isInteger(waveSize) || waveSize <= 0) return { wave: [], rest: [...remaining] };
  return { wave: remaining.slice(0, waveSize), rest: remaining.slice(waveSize) };
}
