// Board self-deploy (myrmidon R5-A): the job model of an update started from
// the interface. Pure rules: no I/O and no clock reads here; callers pass `now`.
//
// A job is a state machine over one image digest. The digest is verified the
// same way scripts/myrmidon/deploy/deploy.sh verifies it (see docs/myrmidon/
// deploy.md, "CI-built images only"): the reference is exactly
// ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>, the image is in the registry,
// its OCI labels name the CI workflow, and the label commit is reachable from
// origin/main or carries a myr-v* tag. There is deliberately no state, flag or
// setting that skips verification: a job never reaches "running" with an
// unverified image.
//
// Design: docs/myrmidon/design/deploy-from-ui.md.

export const DEPLOY_IMAGE_REPOSITORY = "ghcr.io/itkadr-git/myrmidon";
export const DEPLOY_IMAGE_SOURCE = "https://github.com/itkadr-git/myrmidon";

/** Digest form the board accepts: `sha256:<64 lowercase hex>`, optionally with the repository prefix. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export type DeployJobStatus =
  | "pending"
  | "verifying"
  | "verified"
  | "failed_verification"
  | "maintenance_entering"
  | "maintenance_on"
  | "maintenance_failed"
  | "running"
  | "succeeded"
  | "failed_health"
  | "aborted";

/** Statuses under which the job still expects progress from the server itself. */
export const DEPLOY_JOB_ACTIVE_STATUSES: readonly DeployJobStatus[] = [
  "pending",
  "verifying",
  "verified",
  "maintenance_entering",
  "maintenance_on",
  "running",
];

/** A job the host executor may pick up. */
export const DEPLOY_JOB_DISPATCHABLE_STATUSES: readonly DeployJobStatus[] = [
  "maintenance_on",
  "running",
];

export function isDeployJobActive(status: DeployJobStatus): boolean {
  return DEPLOY_JOB_ACTIVE_STATUSES.includes(status);
}

export function isDeployJobDispatchable(status: DeployJobStatus): boolean {
  return DEPLOY_JOB_DISPATCHABLE_STATUSES.includes(status);
}

export interface DeployJobStep {
  at: string;
  status: DeployJobStatus;
  detail: string;
}

export interface DeployJob {
  id: string;
  companyId: string;
  digest: string;
  /** Expected /api/health version of the new image, from its OCI label. */
  version: string | null;
  /** Commit the image was built from, from its OCI label. */
  commit: string | null;
  status: DeployJobStatus;
  reason: string;
  startedBy: { actorType: string; actorId: string };
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  maintenanceWindowId: string | null;
  healthVersion: string | null;
  healthCommit: string | null;
  failureReason: string | null;
  steps: DeployJobStep[];
}

export interface DeployJobDocument {
  version: 1;
  /** At most one job that is not terminal; see assertOneActiveJob. */
  jobs: DeployJob[];
  history: DeployJob[];
}

export const DEPLOY_JOB_HISTORY_LIMIT = 20;

export function emptyDeployJobDocument(): DeployJobDocument {
  return { version: 1, jobs: [], history: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUSES: readonly DeployJobStatus[] = [
  "pending",
  "verifying",
  "verified",
  "failed_verification",
  "maintenance_entering",
  "maintenance_on",
  "maintenance_failed",
  "running",
  "succeeded",
  "failed_health",
  "aborted",
];

function parseStep(raw: unknown): DeployJobStep | null {
  if (!isRecord(raw) || typeof raw.at !== "string" || typeof raw.status !== "string" || !STATUSES.includes(raw.status as DeployJobStatus)) {
    return null;
  }
  return { at: raw.at, status: raw.status as DeployJobStatus, detail: typeof raw.detail === "string" ? raw.detail : "" };
}

/** Read the stored document defensively: anything malformed drops out. */
export function parseDeployJobDocument(raw: unknown): DeployJobDocument {
  if (!isRecord(raw) || !Array.isArray(raw.jobs)) return emptyDeployJobDocument();
  const jobs: DeployJob[] = [];
  for (const item of raw.jobs) {
    const job = parseJob(item);
    if (job) jobs.push(job);
  }
  const history = Array.isArray(raw.history)
    ? (raw.history.filter(isRecord).map(parseJob).filter((j): j is DeployJob => j !== null))
    : [];
  return { version: 1, jobs, history };
}

function parseJob(raw: unknown): DeployJob | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.digest !== "string") return null;
  if (typeof raw.status !== "string" || !STATUSES.includes(raw.status as DeployJobStatus)) return null;
  return {
    id: raw.id,
    companyId: typeof raw.companyId === "string" ? raw.companyId : "",
    digest: raw.digest,
    version: typeof raw.version === "string" ? raw.version : null,
    commit: typeof raw.commit === "string" ? raw.commit : null,
    status: raw.status as DeployJobStatus,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    startedBy: isRecord(raw.startedBy)
      ? { actorType: String(raw.startedBy.actorType ?? ""), actorId: String(raw.startedBy.actorId ?? "") }
      : { actorType: "", actorId: "" },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    verifiedAt: typeof raw.verifiedAt === "string" ? raw.verifiedAt : null,
    maintenanceWindowId: typeof raw.maintenanceWindowId === "string" ? raw.maintenanceWindowId : null,
    healthVersion: typeof raw.healthVersion === "string" ? raw.healthVersion : null,
    healthCommit: typeof raw.healthCommit === "string" ? raw.healthCommit : null,
    failureReason: typeof raw.failureReason === "string" ? raw.failureReason : null,
    steps: Array.isArray(raw.steps) ? (raw.steps.map(parseStep).filter((s): s is DeployJobStep => s !== null)) : [],
  };
}

/**
 * Why a digest is not exactly `<repo>@sha256:<64 lowercase hex>`. The wording
 * mirrors image_ref_problem() of scripts/myrmidon/deploy/lib.sh so the
 * interface and the script refuse the same input the same way.
 */
export function digestProblem(input: string): string | null {
  if (input === null || input === undefined) return "no image given";
  const trimmed = input.trim();
  if (!trimmed) return "no image given: pass the digest of an image built by CI as sha256:<64 hex>";
  let digest = trimmed;
  if (digest.includes("@")) {
    const repo = digest.slice(0, digest.lastIndexOf("@"));
    if (repo !== DEPLOY_IMAGE_REPOSITORY) {
      return `image '${repo}' is not ${DEPLOY_IMAGE_REPOSITORY}: only images built by CI in this repository are deployed`;
    }
    digest = digest.slice(digest.lastIndexOf("@") + 1);
  } else if (digest.includes(":") && !digest.startsWith("sha256:")) {
    return `'${digest}' has no digest (it is a tag or a name); tags can be moved. CI images are referenced as ${DEPLOY_IMAGE_REPOSITORY}@sha256:<64 hex>, the digest is in the CI run summary`;
  }
  if (!DIGEST_RE.test(digest)) {
    return "digest must be sha256: followed by 64 lowercase hex characters";
  }
  return null;
}

/** The digest of a full reference or of a bare digest, or null when invalid. */
export function parseDigest(input: string): string | null {
  if (typeof input !== "string") return null;
  if (digestProblem(input) !== null) return null;
  const at = input.trim().lastIndexOf("@");
  return at === -1 ? input.trim() : input.trim().slice(at + 1);
}

export interface ImageVerification {
  ok: boolean;
  digest: string | null;
  version: string | null;
  commit: string | null;
  reason: string | null;
}

/**
 * The full CI-image check for one reference, from facts the caller fetched
 * (registry labels, GitHub reachability of the commit). The caller owns the
 * I/O so tests can feed plain objects; the rules are the same four the deploy
 * script applies:
 *
 * 1. the reference is exactly `<repo>@sha256:<64 hex>`;
 * 2. the image is in the registry (a fetched label set exists);
 * 3. `org.opencontainers.image.revision` is a full commit sha and
 *    `org.opencontainers.image.source` equals our repository;
 * 4. that commit is on origin/main or carries a myr-v* release tag.
 */
export function verifyCiImage(input: {
  reference: string;
  labels: Record<string, string> | null;
  /** Is the label commit reachable from origin/main (GitHub said so)? */
  commitOnMain: (commit: string) => boolean;
  /** Release tags of the repository that point at the commit. */
  releaseTagsAtCommit: string[] | null;
}): ImageVerification {
  const problem = digestProblem(input.reference);
  if (problem) return { ok: false, digest: null, version: null, commit: null, reason: problem };
  const digest = parseDigest(input.reference)!;

  if (!input.labels) {
    return {
      ok: false,
      digest,
      version: null,
      commit: null,
      reason: `${DEPLOY_IMAGE_REPOSITORY}@${digest} cannot be read from the registry (never pushed there, deleted, or the registry is unreachable)`,
    };
  }
  const commit = input.labels["org.opencontainers.image.revision"] ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return {
      ok: false,
      digest,
      version: null,
      commit: null,
      reason: `${DEPLOY_IMAGE_REPOSITORY}@${digest} has no org.opencontainers.image.revision label with a full commit sha, so it was not built by the CI image workflow`,
    };
  }
  const source = input.labels["org.opencontainers.image.source"] ?? "";
  if (source !== DEPLOY_IMAGE_SOURCE) {
    return {
      ok: false,
      digest,
      version: null,
      commit,
      reason: `${DEPLOY_IMAGE_REPOSITORY}@${digest} has org.opencontainers.image.source '${source || "<none>"}', expected ${DEPLOY_IMAGE_SOURCE}: it was not built by the CI image workflow`,
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
export function appendStep(job: DeployJob, status: DeployJobStatus, detail: string, now: Date): DeployJob {
  const steps = [...job.steps, { at: now.toISOString(), status, detail }].slice(-100);
  return { ...job, steps };
}

/** Move a finished job to history, newest first, bounded. */
export function retireJob(doc: DeployJobDocument, jobId: string, now: Date): DeployJobDocument {
  const job = doc.jobs.find((j) => j.id === jobId);
  if (!job) return doc;
  return {
    version: 1,
    jobs: doc.jobs.filter((j) => j.id !== jobId),
    history: [{ ...job, updatedAt: now.toISOString() }, ...doc.history].slice(0, DEPLOY_JOB_HISTORY_LIMIT),
  };
}

export function newDeployJob(input: {
  id: string;
  companyId: string;
  digest: string;
  reason: string;
  startedBy: { actorType: string; actorId: string };
  now: Date;
}): DeployJob {
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
    maintenanceWindowId: null,
    healthVersion: null,
    healthCommit: null,
    failureReason: null,
    steps: [{ at: createdAt, status: "pending", detail: "job created" }],
  };
}

/**
 * May a new job start, given the open jobs? At most one job that is not
 * terminal may exist: a second deploy while one is in flight is a request
 * conflict (409), not a queue. The host runs one switch at a time; the
 * interface shows the live job and a new one is only useful after it ends.
 */
export function assertNoActiveJob(doc: DeployJobDocument): void {
  const active = doc.jobs.filter((j) => isDeployJobActive(j.status));
  if (active.length > 0) {
    throw new DeployJobConflict(
      `a deploy of ${DEPLOY_IMAGE_REPOSITORY}@${active[0].digest.slice(0, 19)} is already in progress (status ${active[0].status}); wait for it to finish or abort it`,
    );
  }
}

export class DeployJobConflict extends Error {
  readonly conflictStatus = 409;
}

/**
 * Whether the job may be aborted right now: before the host starts the image
 * switch anything is cancellable; once the switch started the operator's tool
 * is the rollback, not an abort. (`running` is the host's switch.)
 */
export function isAbortable(job: DeployJob): boolean {
  return ["pending", "verifying", "verified", "maintenance_entering"].includes(job.status);
}
