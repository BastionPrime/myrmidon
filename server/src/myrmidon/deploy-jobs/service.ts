// Board self-deploy (myrmidon R5-A): the job lifecycle.
//
// One job walks: verify the digest as a CI image → open an instance
// maintenance window → wait for `on` → hand the job to the host executor →
// read its result (health of the new image) → leave maintenance. The board
// never runs docker itself: the switch is the deploy script's `--from-job`
// mode on the host (see scripts/myrmidon/deploy), polled through a small
// host-report file the script writes. A job whose window cannot open, whose
// step exceeds MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC, or whose health fails is
// terminal with the reason on the job; the operator's tools are the exit and
// the rollback, exactly as with a script deploy.
//
// Invariants the service keeps:
//
// - at most one non-terminal job exists (assertNoActiveJob under the row lock);
// - the image check runs BEFORE the maintenance window opens: a refused image
//   changes nothing, not even the board's own run admission;
// - the maintenance window is entered with reason "deploy <digest-prefix>"
//   and left when the job ends, whichever way it ends;
// - maintenance_on → running only after the window reported state `on`;
// - running → succeeded only when the host reported the new version/commit
//   healthy; otherwise failed_health, and the window stays open for the
//   rollback (the same contract as deploy.sh step 7/8).

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import {
  DEPLOY_IMAGE_REPOSITORY,
  DeployJobConflict,
  appendStep,
  assertNoActiveJob,
  digestProblem,
  isAbortable,
  isDeployJobActive,
  newDeployJob,
  parseDigest,
  retireJob,
  verifyCiImage,
  type DeployJob,
  type DeployJobDocument,
  type DeployJobStatus,
} from "./domain.js";
import { readDeployJobsSettings, type DeployJobsSettings } from "./settings.js";

/** Storage the service talks to: the instance_settings row (or a test double). */
export interface DeployJobStore {
  read(): Promise<DeployJobDocument>;
  mutate<T>(change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T }): Promise<{
    doc: DeployJobDocument;
    result: T;
    changed: boolean;
  }>;
}

function defaultStore(db: Db): DeployJobStore {
  return {
    read: () => readDeployJobDocument(db),
    mutate: (change) => mutateDeployJobDocument(db, change),
  };
}

function fakeStore(db: unknown): DeployJobStore | null {
  const candidate = db as Partial<DeployJobStore> | null;
  if (candidate && typeof candidate.read === "function" && typeof candidate.mutate === "function") {
    return candidate as DeployJobStore;
  }
  return null;
}

function resolveStore(db: Db): DeployJobStore {
  return fakeStore(db) ?? defaultStore(db);
}
import { mutateDeployJobDocument, readDeployJobDocument } from "./store.js";
import { verifyImage, type ProbeDeps } from "./registry.js";

/** What the service needs from maintenance mode (R3): the same API the deploy script uses. */
export interface DeployMaintenancePort {
  enter(input: { reason: string; drainTimeoutSec?: number }): Promise<{ id: string; state: string }>;
  exit(reason?: string): Promise<{ state: string }>;
  status(): Promise<{ instance: { id: string; state: string } | null }>;
}

/** What the host executor reports (written by deploy.sh --from-job). */
export interface HostReport {
  jobId: string;
  phase: "claimed" | "switching" | "switched" | "health-ok" | "health-failed" | "error";
  version?: string | null;
  commit?: string | null;
  detail?: string | null;
  at?: string;
}

export interface DeployJobServiceDeps {
  maintenance: DeployMaintenancePort;
  /** Read the host executor's report file (or fetch it); null when there is none yet. */
  readHostReport: (jobId: string) => Promise<HostReport | null>;
  /** Health facts of the running server, as /api/health reports them. */
  readHealth: () => Promise<{ version: string | null; commit: string | null } | null>;
  now?: () => Date;
  settings?: DeployJobsSettings;
  probes?: ProbeDeps;
  logActivity?: typeof logActivity;
}

export class DeployJobError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface DeployJobView extends DeployJob {
  active: boolean;
  abortable: boolean;
}

export function toView(job: DeployJob): DeployJobView {
  return { ...job, active: isDeployJobActive(job.status), abortable: isAbortable(job) };
}

export function deployJobsService(db: Db, deps: DeployJobServiceDeps) {
  const store = resolveStore(db);
  const now = deps.now ?? (() => new Date());
  const settings = deps.settings ?? readDeployJobsSettings();
  const audit = deps.logActivity ?? ((dbArg, entry) => logActivity(dbArg, entry));

  async function findActiveJob(): Promise<DeployJob | null> {
    const doc = await store.read();
    return doc.jobs.find((j) => isDeployJobActive(j.status)) ?? null;
  }

  async function write<T>(change: (doc: DeployJobDocument) => { next: DeployJobDocument | null; result: T }) {
    return store.mutate(change);
  }

  function updateJob(doc: DeployJobDocument, id: string, patch: Partial<DeployJob>): DeployJobDocument {
    return { ...doc, jobs: doc.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) };
  }

  async function auditFor(job: DeployJob, action: string, actor: { actorType: string; actorId: string }, details: Record<string, unknown> = {}) {
    try {
      await audit(db, {
        companyId: job.companyId,
        actorType: actor.actorType as "user" | "system",
        actorId: actor.actorId,
        action: `myrmidon.deploy_jobs.${action}`,
        entityType: "myrmidon_deploy_job",
        entityId: job.id,
        details: { digest: job.digest, status: job.status, ...details },
      });
    } catch (err) {
      logger.error({ err, jobId: job.id, action }, "failed to write deploy job activity");
    }
  }

  async function currentView(): Promise<{ job: DeployJobView | null; history: DeployJobView[] }> {
    const doc = await store.read();
    const active = doc.jobs.find((j) => isDeployJobActive(j.status)) ?? null;
    const last = doc.jobs[doc.jobs.length - 1] ?? doc.history[0] ?? null;
    return {
      job: active ? toView(active) : last ? toView(last) : null,
      history: doc.history.map(toView),
    };
  }

  /** Preview: verify a digest without creating a job. Read-only. */
  async function preview(reference: string) {
    const problem = digestProblem(reference ?? "");
    if (problem) throw new DeployJobError(400, problem);
    const verification = await verifyImage(reference, deps.probes);
    return verification;
  }

  /** Create a job and start verification. */
  async function create(input: { reference: string; reason?: string }, actor: { actorType: string; actorId: string }): Promise<DeployJobView> {
    if (!settings.enabled) {
      throw new DeployJobError(503, "deploys from the interface are not enabled on this instance (MYRMIDON_DEPLOY_ENABLED)");
    }
    const problem = digestProblem(input.reference ?? "");
    if (problem) throw new DeployJobError(400, problem);
    const digest = parseDigest(input.reference)!;

    const { result: created } = await write((doc) => {
      try {
        assertNoActiveJob(doc);
      } catch (err) {
        if (err instanceof DeployJobConflict) throw new DeployJobError(409, err.message);
        throw err;
      }
      const job = newDeployJob({
        id: randomUUID(),
        companyId: "", // filled below from the first company; instance-level feature
        digest,
        reason: (input.reason ?? `deploy ${DEPLOY_IMAGE_REPOSITORY}@${digest.slice(0, 19)}`).slice(0, 500),
        startedBy: actor,
        now: now(),
      });
      return { next: { ...doc, jobs: [...doc.jobs, job] }, result: job };
    });

    await auditFor(created, "created", actor);
    // Verification runs outside the lock; its result lands on the job (and a
    // refusal retires the job into history — the operator reads the reason
    // from the returned view and from history).
    const verification = await verifyImage(`${DEPLOY_IMAGE_REPOSITORY}@${digest}`, deps.probes);
    const applied = await applyVerification(created.id, verification);
    let job: DeployJob = applied;
    if (job.status === "verified") {
      await enterMaintenance(job);
    } else {
      await auditFor(job, "image_refused", actor, { reason: job.failureReason });
    }
    const after = (await store.read()).jobs.find((j) => j.id === created.id) ?? job;
    return toView(after);
  }

  async function applyVerification(jobId: string, verification: Awaited<ReturnType<typeof verifyImage>>): Promise<DeployJob> {
    const at = now();
    let applied: DeployJob | null = null;
    await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || (job.status !== "verifying" && job.status !== "pending")) return { next: null, result: null };
      if (verification.ok) {
        const next = appendStep(
          { ...job, status: "verified", version: verification.version, commit: verification.commit, verifiedAt: at.toISOString(), updatedAt: at.toISOString(), failureReason: null },
          "verified",
          `verified CI image: commit ${verification.commit?.slice(0, 12)}, version ${verification.version ?? "<none>"}`,
          at,
        );
        applied = next;
        return { next: updateJob(doc, jobId, next), result: next.status };
      }
      const next = appendStep(
        { ...job, status: "failed_verification", failureReason: verification.reason, updatedAt: at.toISOString() },
        "failed_verification",
        verification.reason ?? "image refused",
        at,
      );
      applied = next;
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: "failed_verification" };
    });
    if (applied) return applied;
    // Another writer already moved the job (a restart, a concurrent tick):
    // return whatever is stored now.
    const stored = (await store.read()).jobs.find((j) => j.id === jobId);
    if (stored) return stored;
    throw new DeployJobError(404, "deploy job not found");
  }

  async function enterMaintenance(job: DeployJob) {
    const at = now();
    try {
      const window = await deps.maintenance.enter({ reason: `deploy ${DEPLOY_IMAGE_REPOSITORY}@${job.digest.slice(0, 19)}` });
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || !isDeployJobActive(current.status) || current.status === "running") return { next: null, result: null };
        const next = appendStep(
          { ...current, status: "maintenance_entering", maintenanceWindowId: window.id, updatedAt: at.toISOString() },
          "maintenance_entering",
          `maintenance window ${window.id} entered (state ${window.state})`,
          at,
        );
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || !isDeployJobActive(current.status)) return { next: null, result: null };
        const next = appendStep(
          { ...current, status: "maintenance_failed", failureReason: `maintenance enter failed: ${message}`, updatedAt: at.toISOString() },
          "maintenance_failed",
          `maintenance enter failed: ${message}`,
          at,
        );
        const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === job.id ? next : j)) }, job.id, at);
        return { next: retired, result: "maintenance_failed" };
      });
      await auditFor(job, "maintenance_failed", { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { error: message });
    }
  }

  /** Abort a job that has not started the image switch. */
  async function abort(jobId: string, actor: { actorType: string; actorId: string }): Promise<DeployJobView> {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job) return { next: null, result: new DeployJobError(404, "deploy job not found") as DeployJobError | DeployJob };
      if (!isAbortable(job)) {
        return {
          next: null,
          result: new DeployJobError(409, `job in status ${job.status} cannot be aborted: the image switch already started; use the rollback`) as DeployJobError | DeployJob,
        };
      }
      const next = appendStep(
        { ...job, status: "aborted", failureReason: "aborted by operator", updatedAt: at.toISOString() },
        "aborted",
        "aborted by operator",
        at,
      );
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next as DeployJob };
    });
    if (result instanceof DeployJobError) throw result;
    // Leave the window the job opened (a no-op when none was opened yet).
    await deps.maintenance.exit("deploy job aborted").catch((err) => {
      logger.error({ err, jobId }, "failed to leave maintenance after abort");
    });
    await auditFor(result, "aborted", actor);
    return toView(result);
  }

  /**
   * The reconciliation tick: drive the open job forward from facts (window
   * state, host report, health), the way the maintenance tick drives windows.
   * Safe to run often; every step is idempotent and guarded by status checks.
   */
  async function tick(): Promise<void> {
    const doc = await store.read();
    const job = doc.jobs.find((j) => isDeployJobActive(j.status));
    if (!job) return;
    const at = now();

    // A step stuck too long aborts the job: the interface must not leave a
    // half-open window forever (MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC per status).
    const lastStep = job.steps[job.steps.length - 1];
    if (lastStep && at.getTime() - Date.parse(job.updatedAt) > settings.stepTimeoutMs) {
      await failJob(job.id, "aborted", `step ${job.status} exceeded the timeout (${Math.round(settings.stepTimeoutMs / 1000)}s)`);
      return;
    }

    switch (job.status) {
      case "pending":
      case "verifying": {
        // Verification normally completes in create(); a restart left it here.
        const verification = await verifyImage(`${DEPLOY_IMAGE_REPOSITORY}@${job.digest}`, deps.probes);
        await applyVerification(job.id, verification);
        const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
        if (fresh && fresh.status === "verified") await enterMaintenance(fresh);
        return;
      }
      case "maintenance_entering": {
        const status = await deps.maintenance.status();
        const window = status.instance;
        if (!window) {
          // The window vanished (someone exited it by hand): retry once by
          // opening our own again; if that fails the job fails.
          await enterMaintenance(job);
          return;
        }
        if (window.state === "on") {
          await write((doc2) => {
            const current = doc2.jobs.find((j) => j.id === job.id);
            if (!current || current.status !== "maintenance_entering") return { next: null, result: null };
            const next = appendStep(
              { ...current, status: "maintenance_on", updatedAt: at.toISOString() },
              "maintenance_on",
              "maintenance window is on; host executor may switch the image",
              at,
            );
            return { next: updateJob(doc2, job.id, next), result: next.status };
          });
          return;
        }
        if (window.state === "leaving") {
          await failJob(job.id, "aborted", "maintenance window was exited while the deploy waited for it");
        }
        return;
      }
      case "maintenance_on": {
        // The host executor claims the job (phase claimed/switching) — the
        // board follows the report, it does not switch anything itself.
        const report = await deps.readHostReport(job.id).catch(() => null);
        if (!report) return; // the host has not picked the job up yet
        await write((doc2) => {
          const current = doc2.jobs.find((j) => j.id === job.id);
          if (!current || current.status !== "maintenance_on") return { next: null, result: null };
          const next = appendStep(
            { ...current, status: "running", updatedAt: at.toISOString() },
            "running",
            `host executor: ${report.phase}${report.detail ? ` (${report.detail})` : ""}`,
            at,
          );
          return { next: updateJob(doc2, job.id, next), result: next.status };
        });
        return;
      }
      case "running": {
        const report = await deps.readHostReport(job.id).catch(() => null);
        if (!report) return;
        if (report.phase === "health-ok") {
          const health = await deps.readHealth().catch(() => null);
          const healthy =
            health !== null &&
            (job.commit === null || health.commit === job.commit) &&
            (job.version === null || health.version === job.version);
          const nextStatus: DeployJobStatus = healthy ? "succeeded" : "failed_health";
          const detail = healthy
            ? `new image healthy: version ${health?.version ?? "<none>"}, commit ${health?.commit?.slice(0, 12) ?? "<none>"}`
            : `host reported health-ok but /api/health disagrees: got version ${health?.version ?? "<none>"}, commit ${health?.commit?.slice(0, 12) ?? "<none>"}`;
          await finish(job.id, nextStatus, detail, report);
          return;
        }
        if (report.phase === "health-failed" || report.phase === "error") {
          const detail = `host executor failed: ${report.phase}${report.detail ? ` — ${report.detail}` : ""}`;
          await finish(job.id, "failed_health", detail, report);
          return;
        }
        return; // claimed/switching/switched: still in progress
      }
      default:
        return;
    }
  }

  async function finish(jobId: string, status: Extract<DeployJobStatus, "succeeded" | "failed_health">, detail: string, report: HostReport) {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "running") return { next: null, result: null as DeployJob | null };
      const next = appendStep(
        {
          ...job,
          status,
          healthVersion: report.version ?? null,
          healthCommit: report.commit ?? null,
          failureReason: status === "failed_health" ? detail : null,
          updatedAt: at.toISOString(),
        },
        status,
        detail,
        at,
      );
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next };
    });
    if (!result) return;
    // Leave maintenance on success; on a failed health check the window stays
    // on for the rollback, the same contract as deploy.sh step 7.
    if (status === "succeeded") {
      await deps.maintenance.exit("deploy finished").catch((err) => {
        logger.error({ err, jobId }, "failed to leave maintenance after deploy");
      });
    }
    await auditFor(result, status, { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { detail });
  }

  async function failJob(jobId: string, status: Extract<DeployJobStatus, "aborted" | "failed_health">, reason: string) {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || !isDeployJobActive(job.status)) return { next: null, result: null as DeployJob | null };
      const next = appendStep({ ...job, status, failureReason: reason, updatedAt: at.toISOString() }, status, reason, at);
      const retired = retireJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next };
    });
    if (!result) return;
    await deps.maintenance.exit(`deploy job ${status}`).catch((err) => {
      logger.error({ err, jobId }, "failed to leave maintenance after job failure");
    });
    await auditFor(result, status, { actorType: "system", actorId: "myrmidon-deploy-jobs" }, { reason });
  }

  return {
    current: currentView,
    preview,
    create,
    abort,
    tick,
  };
}

export type DeployJobsService = ReturnType<typeof deployJobsService>;

// Re-export for the routes: the pure check the UI preview shares with create.
export { digestProblem, verifyCiImage };
