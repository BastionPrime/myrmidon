// myrmidon(R5-B): the bot image rollout lifecycle.
//
// One rollout walks: verify the digest as a CI image → pick the canary (the
// setting's bot) → run the canary's reconcile with the NEW image (drain of
// that agent alone, recreate, start) → wait for Docker's health verdict →
// settle → one smoke run over the canary's gateway → waves: the remaining
// container bots, waveSize at a time, each through its own reconcile with the
// new image → succeeded.
//
// Invariants the service keeps:
//
// - at most one non-terminal rollout exists (assertNoActiveBotCanary under the
//   row lock, the same pattern the board self-deploy uses);
// - the image check runs BEFORE the canary is touched: a refused image changes
//   nothing, not even the canary bot's own container;
// - the canary is ONE bot: a failed canary health or smoke stops the rollout
//   with canary_failed / canary_smoke_failed and no other bot is touched —
//   the acceptance criterion "when the canary fails, the other containers are
//   left alone" is the state machine's own shape, not a convention;
// - waves only ever run after the canary succeeded (the wave statuses are
//   reachable only through canary smoke success);
// - the rollout changes images by driving the SAME reconciler the periodic
//   sweep uses (applyBotContainerNow with a spec whose image is the new
//   reference): no second template, no second drain logic, and the per-bot
//   lock serializes the rollout with the sweep for that bot;
// - abort leaves nothing half-applied: before canary_running nothing has been
//   changed; after it, the tool is the rollback (R5-C), as with the board
//   self-deploy.
//
// myrmidon(R5-C), auto-rollback by health: with
// MYRMIDON_BOT_CANARY_AUTO_ROLLBACK on (the default) a failed rollout is not
// left on the new image. The failure path goes through `failOrRollback`:
// instead of a terminal status the rollout moves to `rolling_back`, and the
// tick restores every bot that received the rollout's image (the canary and
// the applied wave bots) to its OWN card image — the local image the card
// pinned before the rollout — with the same applyNow, then the rollout ends
// `rolled_back` with the original failure reason kept on the job. A rollback
// apply error or timeout ends `aborted` with the reason: the sweep remains
// the authority that re-applies the card image on its next pass anyway. With
// the rollback off the rollout ends `canary_failed` / `canary_smoke_failed` /
// `failed_health` as before.
//
// State is stored in instance_settings.general under the `myrmidonBotCanary`
// key (the same storage pattern as R3/R5-A); the store module owns the row
// locking, this module owns the rules.

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import {
  BOT_CANARY_IMAGE_REPOSITORY,
  appendBotCanaryStep,
  assertNoActiveBotCanary,
  BotCanaryConflict,
  botCanaryReferenceProblem,
  botCanaryRollbackTargets,
  isBotCanaryActive,
  isBotCanaryAbortable,
  newBotCanaryJob,
  parseBotCanaryDigest,
  planNextBotCanaryWave,
  retireBotCanaryJob,
  verifyBotCanaryImage,
  type BotCanaryDocument,
  type BotCanaryJob,
  type BotCanaryStatus,
} from "./canary-domain.js";
import { verifyBotCanaryImageFromRegistry, type BotCanaryProbeDeps } from "./canary-registry.js";
import { runCanarySmoke } from "./canary-smoke.js";
import { readBotCanarySettings, type BotCanarySettings } from "./canary-settings.js";
import {
  readBotCanaryDocument,
  mutateBotCanaryDocument,
} from "./canary-store.js";
import type { BotContainerAgent, BotContainerRuntimeDeps, ApplyBotContainerOutcome } from "./index.js";

/** Storage the service talks to: the instance_settings row (or a test double). */
export interface BotCanaryStore {
  read(): Promise<BotCanaryDocument>;
  mutate<T>(change: (current: BotCanaryDocument) => { next: BotCanaryDocument | null; result: T }): Promise<{
    doc: BotCanaryDocument;
    result: T;
    changed: boolean;
  }>;
}

function defaultStore(db: Db): BotCanaryStore {
  return {
    read: () => readBotCanaryDocument(db),
    mutate: (change) => mutateBotCanaryDocument(db, change),
  };
}

function fakeStore(db: unknown): BotCanaryStore | null {
  const candidate = db as Partial<BotCanaryStore> | null;
  if (candidate && typeof candidate.read === "function" && typeof candidate.mutate === "function") {
    return candidate as BotCanaryStore;
  }
  return null;
}

function resolveStore(db: Db): BotCanaryStore {
  return fakeStore(db) ?? defaultStore(db);
}

/** What the service needs from the bot container runtime. */
export interface BotCanaryRuntimePort {
  /** The agents the sweep reconciles (listAgents of startup.ts, the same query). */
  listAgents(): Promise<BotContainerAgent[]>;
  /** applyBotContainerNow with the given image override (the sweep's own entry point). */
  applyNow(agent: BotContainerAgent, image: string, env: NodeJS.ProcessEnv): Promise<ApplyBotContainerOutcome>;
  /** driver.status — the health source of the canary (Docker HEALTHCHECK verdict). */
  status(botKey: string): Promise<{ state: string; image?: string }>;
  /** The canary bot's gateway key (API_SERVER_KEY), for the smoke run. */
  canaryApiKey(botKey: string): Promise<string | null>;
}

export interface BotCanaryServiceDeps {
  runtime: BotCanaryRuntimePort;
  now?: () => Date;
  settings?: BotCanarySettings;
  probes?: BotCanaryProbeDeps;
  logActivity?: typeof logActivity;
  env?: NodeJS.ProcessEnv;
  /** Test hook: replaces the smoke run. */
  smoke?: typeof runCanarySmoke;
}

export class BotCanaryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface BotCanaryView extends BotCanaryJob {
  active: boolean;
  abortable: boolean;
}

export function toBotCanaryView(job: BotCanaryJob): BotCanaryView {
  return { ...job, active: isBotCanaryActive(job.status), abortable: isBotCanaryAbortable(job) };
}

export function botCanaryService(db: Db, deps: BotCanaryServiceDeps) {
  const store = resolveStore(db);
  const now = deps.now ?? (() => new Date());
  const settings = deps.settings ?? readBotCanarySettings();
  const env = deps.env ?? process.env;
  const audit = deps.logActivity ?? ((dbArg: unknown, entry: Parameters<typeof logActivity>[1]) => logActivity(dbArg as Db, entry));
  const smoke = deps.smoke ?? runCanarySmoke;

  async function write<T>(change: (doc: BotCanaryDocument) => { next: BotCanaryDocument | null; result: T }) {
    return store.mutate(change);
  }

  function updateJob(doc: BotCanaryDocument, id: string, patch: Partial<BotCanaryJob>): BotCanaryDocument {
    return { ...doc, jobs: doc.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) };
  }

  async function auditFor(job: BotCanaryJob, action: string, actor: { actorType: string; actorId: string }, details: Record<string, unknown> = {}) {
    try {
      await audit(db, {
        companyId: job.companyId,
        actorType: actor.actorType as "user" | "system",
        actorId: actor.actorId,
        action: `myrmidon.bot_canary.${action}`,
        entityType: "myrmidon_bot_canary",
        entityId: job.id,
        details: { digest: job.digest, status: job.status, ...details },
      });
    } catch (err) {
      logger.error({ err, jobId: job.id, action }, "failed to write bot canary activity");
    }
  }

  async function currentView(): Promise<{ job: BotCanaryView | null; history: BotCanaryView[] }> {
    const doc = await store.read();
    const active = doc.jobs.find((j) => isBotCanaryActive(j.status)) ?? null;
    const last = doc.jobs[doc.jobs.length - 1] ?? doc.history[0] ?? null;
    return {
      job: active ? toBotCanaryView(active) : last ? toBotCanaryView(last) : null,
      history: doc.history.map(toBotCanaryView),
    };
  }

  /** Preview: verify a reference without creating a rollout. Read-only. */
  async function preview(reference: string) {
    const problem = botCanaryReferenceProblem(reference);
    if (problem) throw new BotCanaryError(400, problem);
    return verifyBotCanaryImageFromRegistry(reference, deps.probes);
  }

  /** Create a rollout and start verification. */
  async function create(input: { reference: string; reason?: string }, actor: { actorType: string; actorId: string }): Promise<BotCanaryView> {
    if (!settings.enabled) {
      throw new BotCanaryError(503, "bot image canaries are not enabled on this instance (MYRMIDON_BOT_CANARY)");
    }
    if (!settings.canaryBotKey) {
      throw new BotCanaryError(503, "MYRMIDON_BOT_CANARY_SELECTOR is not set: the canary bot must be chosen explicitly, not guessed");
    }
    const problem = botCanaryReferenceProblem(input.reference ?? "");
    if (problem) throw new BotCanaryError(400, problem);
    const digest = parseBotCanaryDigest(input.reference)!;
    const canaryBotKey = settings.canaryBotKey;

    const { result: created } = await write((doc) => {
      try {
        assertNoActiveBotCanary(doc);
      } catch (err) {
        if (err instanceof BotCanaryConflict) throw new BotCanaryError(409, err.message);
        throw err;
      }
      const job = newBotCanaryJob({
        id: randomUUID(),
        companyId: "",
        digest,
        canaryBotKey,
        reason: (input.reason ?? `bot image rollout ${BOT_CANARY_IMAGE_REPOSITORY}@${digest.slice(0, 19)}`).slice(0, 500),
        startedBy: actor,
        now: now(),
      });
      return { next: { ...doc, jobs: [...doc.jobs, job] }, result: job };
    });

    await auditFor(created, "created", actor);
    // Verification runs outside the lock; its result lands on the job (a
    // refusal retires the rollout into history — the operator reads the reason
    // from the returned view and from history).
    const verification = await verifyBotCanaryImageFromRegistry(`${BOT_CANARY_IMAGE_REPOSITORY}@${digest}`, deps.probes);
    const applied = await applyVerification(created.id, verification);
    let job: BotCanaryJob = applied;
    if (job.status === "verified") {
      job = await enterCanary(job);
    } else {
      await auditFor(job, "image_refused", actor, { reason: job.failureReason });
    }
    const after = (await store.read()).jobs.find((j) => j.id === created.id) ?? job;
    return toBotCanaryView(after);
  }

  async function applyVerification(jobId: string, verification: Awaited<ReturnType<typeof verifyBotCanaryImage>>): Promise<BotCanaryJob> {
    const at = now();
    let applied: BotCanaryJob | null = null;
    await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || (job.status !== "verifying" && job.status !== "pending")) return { next: null, result: null };
      if (verification.ok) {
        const next = appendBotCanaryStep(
          { ...job, status: "verified", version: verification.version, commit: verification.commit, verifiedAt: at.toISOString(), updatedAt: at.toISOString(), failureReason: null },
          "verified",
          `verified CI image: commit ${verification.commit?.slice(0, 12)}, version ${verification.version ?? "<none>"}`,
          at,
        );
        applied = next;
        return { next: updateJob(doc, jobId, next), result: next.status };
      }
      const next = appendBotCanaryStep(
        { ...job, status: "failed_verification", failureReason: verification.reason, updatedAt: at.toISOString() },
        "failed_verification",
        verification.reason ?? "image refused",
        at,
      );
      applied = next;
      const retired = retireBotCanaryJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: "failed_verification" };
    });
    if (applied) return applied;
    const stored = (await store.read()).jobs.find((j) => j.id === jobId);
    if (stored) return stored;
    throw new BotCanaryError(404, "bot canary rollout not found");
  }

  /** Move a verified rollout to canary_waiting: the canary bot is picked. */
  async function enterCanary(job: BotCanaryJob): Promise<BotCanaryJob> {
    const at = now();
    const next = appendBotCanaryStep(
      { ...job, status: "canary_waiting", updatedAt: at.toISOString() },
      "canary_waiting",
      `canary bot ${job.canaryBotKey}: waiting to apply the new image`,
      at,
    );
    await write((doc) => {
      const current = doc.jobs.find((j) => j.id === job.id);
      if (!current || !isBotCanaryActive(current.status) || current.status === "canary_running") return { next: null, result: null };
      return { next: updateJob(doc, job.id, next), result: next.status };
    });
    return next;
  }

  /** Abort a rollout that has not started the canary switch. */
  async function abort(jobId: string, actor: { actorType: string; actorId: string }): Promise<BotCanaryView> {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job) return { next: null, result: new BotCanaryError(404, "bot canary rollout not found") as BotCanaryError | BotCanaryJob };
      if (!isBotCanaryAbortable(job)) {
        return {
          next: null,
          result: new BotCanaryError(409, `rollout in status ${job.status} cannot be aborted: the canary switch already started; use the rollback`) as BotCanaryError | BotCanaryJob,
        };
      }
      const next = appendBotCanaryStep(
        { ...job, status: "aborted", failureReason: "aborted by operator", updatedAt: at.toISOString() },
        "aborted",
        "aborted by operator",
        at,
      );
      const retired = retireBotCanaryJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next as BotCanaryJob };
    });
    if (result instanceof BotCanaryError) throw result;
    await auditFor(result, "aborted", actor);
    return toBotCanaryView(result);
  }

  /**
   * The reconciliation tick: drive the open rollout forward from facts (the
   * canary's container state, the smoke run's verdict, the wave's reconciles),
   * the way the deploy job tick drives its own job. Safe to run often; every
   * step is idempotent and guarded by status checks.
   */
  async function tick(): Promise<void> {
    const doc = await store.read();
    const job = doc.jobs.find((j) => isBotCanaryActive(j.status));
    if (!job) return;
    const at = now();

    // A step stuck too long aborts the rollout: the interface must not leave a
    // half-finished rollout forever (MYRMIDON_BOT_CANARY_STEP_TIMEOUT_SEC per
    // status).
    if (at.getTime() - Date.parse(job.updatedAt) > settings.stepTimeoutMs) {
      await failJob(job.id, "aborted", `step ${job.status} exceeded the timeout (${Math.round(settings.stepTimeoutMs / 1000)}s)`);
      return;
    }

    switch (job.status) {
      case "pending":
      case "verifying": {
        // Verification normally completes in create(); a restart left it here.
        const verification = await verifyBotCanaryImageFromRegistry(`${BOT_CANARY_IMAGE_REPOSITORY}@${job.digest}`, deps.probes);
        await applyVerification(job.id, verification);
        const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
        if (fresh && fresh.status === "verified") await enterCanary(fresh);
        return;
      }
      case "canary_waiting": {
        await startCanary(job);
        return;
      }
      case "canary_running": {
        const status = await deps.runtime.status(job.canaryBotKey!).catch(() => null);
        if (!status) return; // the driver did not answer; the next tick retries
        if (status.state !== "running" && status.state !== "unhealthy") return; // still converging
        const next = appendBotCanaryStep(
          { ...job, status: "canary_health_wait", updatedAt: at.toISOString() },
          "canary_health_wait",
          `canary container is ${status.state}; waiting for the health verdict to settle`,
          at,
        );
        await write((doc2) => {
          const current = doc2.jobs.find((j) => j.id === job.id);
          if (!current || current.status !== "canary_running") return { next: null, result: null };
          return { next: updateJob(doc2, job.id, next), result: next.status };
        });
        return;
      }
      case "canary_health_wait": {
        const status = await deps.runtime.status(job.canaryBotKey!).catch(() => null);
        if (status && (status.state === "unhealthy" || status.state === "stopped")) {
          await failOrRollback(job.id, "canary_failed", `the canary container reported '${status.state}' before the smoke run`);
          return;
        }
        if (!status) return;
        // Settle: healthy for healthSettleMs since the step began.
        const since = Date.parse(job.steps.find((s) => s.status === "canary_health_wait")?.at ?? job.updatedAt);
        if (at.getTime() - since < settings.healthSettleMs) return;
        const next = appendBotCanaryStep(
          { ...job, status: "canary_smoke", updatedAt: at.toISOString() },
          "canary_smoke",
          "running the smoke request against the canary's gateway",
          at,
        );
        await write((doc2) => {
          const current = doc2.jobs.find((j) => j.id === job.id);
          if (!current || current.status !== "canary_health_wait") return { next: null, result: null };
          return { next: updateJob(doc2, job.id, next), result: next.status };
        });
        return;
      }
      case "canary_smoke": {
        await runSmoke(job);
        return;
      }
      case "wave_draining": {
        await startWave(job);
        return;
      }
      case "wave_applying": {
        await continueWave(job);
        return;
      }
      case "wave_restoring": {
        await finishWave(job);
        return;
      }
      case "rolling_back": {
        await continueRollback(job);
        return;
      }
      default:
        return;
    }
  }

  /** Drive the canary bot's reconcile with the new image. */
  async function startCanary(job: BotCanaryJob): Promise<void> {
    const agents = await deps.runtime.listAgents().catch(() => null);
    if (!agents) return;
    const canary = agents.find((a) => a.agentId === job.canaryBotKey);
    if (!canary) {
      await failJob(job.id, "aborted", `the canary bot ${job.canaryBotKey} is not a container bot the sweep reconciles`);
      return;
    }
    const image = `${BOT_CANARY_IMAGE_REPOSITORY}@${job.digest}`;
    const at = now();
    const next = appendBotCanaryStep(
      { ...job, status: "canary_running", updatedAt: at.toISOString() },
      "canary_running",
      `applying ${image.slice(0, 60)} to the canary bot`,
      at,
    );
    await write((doc) => {
      const current = doc.jobs.find((j) => j.id === job.id);
      if (!current || current.status !== "canary_waiting") return { next: null, result: null };
      return { next: updateJob(doc, job.id, next), result: next.status };
    });
    // The apply itself: applyBotContainerNow drives the drain, recreate and
    // start of THIS agent alone, exactly as a card image change would.
    const outcome = await deps.runtime.applyNow(canary, image, env);
    if (outcome.kind === "error") {
      await failOrRollback(job.id, "canary_failed", `the canary reconcile failed: ${outcome.message}`);
      return;
    }
    if (outcome.kind === "deferred") {
      // The canary agent is under someone else's window; retry on later ticks.
      const at2 = now();
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || current.status !== "canary_running") return { next: null, result: null };
        const back = appendBotCanaryStep(
          { ...current, status: "canary_waiting", updatedAt: at2.toISOString() },
          "canary_waiting",
          `canary apply deferred (${outcome.reason}); retrying on a later tick`,
          at2,
        );
        return { next: updateJob(doc, job.id, back), result: back.status };
      });
    }
  }

  /** The smoke step: one run over the canary's gateway. */
  async function runSmoke(job: BotCanaryJob): Promise<void> {
    const apiKey = await deps.runtime.canaryApiKey(job.canaryBotKey!).catch(() => null);
    if (!apiKey) {
      await failOrRollback(job.id, "canary_smoke_failed", "the canary bot's gateway key could not be resolved for the smoke run");
      return;
    }
    const result = await smoke(job.canaryBotKey!, job.id, {
      timeoutMs: settings.smokeTimeoutMs,
      apiKey,
    });
    if (result.ok) {
      const at = now();
      const next = appendBotCanaryStep(
        { ...job, status: "wave_draining", smokeRunId: result.runId, doneBotKeys: [job.canaryBotKey!], updatedAt: at.toISOString() },
        "wave_draining",
        `canary smoke run ${result.runId} finished '${result.status}'; planning the first wave`,
        at,
      );
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || current.status !== "canary_smoke") return { next: null, result: null };
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
      await auditFor(job, "canary_ok", { actorType: "system", actorId: "myrmidon-bot-canary" }, { smokeRunId: result.runId });
      return;
    }
    await failOrRollback(job.id, "canary_smoke_failed", `the canary smoke run failed: ${result.reason}${result.runId ? ` (run ${result.runId})` : ""}`);
    await auditFor(job, "canary_smoke_failed", { actorType: "system", actorId: "myrmidon-bot-canary" }, { reason: result.reason, runId: result.runId });
  }

  /** Plan the wave (bot keys) and move to wave_draining. */
  async function startWave(job: BotCanaryJob): Promise<void> {
    const agents = await deps.runtime.listAgents().catch(() => null);
    if (!agents) return;
    const done = new Set(job.doneBotKeys);
    const remaining = agents
      .map((a) => a.agentId)
      .filter((botKey) => !done.has(botKey));
    if (remaining.length === 0) {
      // The canary WAS the fleet: the rollout is done.
      const at = now();
      const next = appendBotCanaryStep(
        { ...job, status: "succeeded", updatedAt: at.toISOString() },
        "succeeded",
        "the canary was the whole fleet; rollout finished",
        at,
      );
      const retired = { ...next };
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || current.status !== "wave_draining") return { next: null, result: null };
        return { next: retireBotCanaryJob(updateJob(doc, job.id, next), job.id, at), result: next.status };
      });
      void retired;
      await auditFor(job, "succeeded", { actorType: "system", actorId: "myrmidon-bot-canary" });
      return;
    }
    const { wave } = planNextBotCanaryWave(remaining, settings.waveSize);
    const at = now();
    const next = appendBotCanaryStep(
      { ...job, waveBotKeys: wave, updatedAt: at.toISOString() },
      "wave_draining",
      `wave of ${wave.length} bot(s): ${wave.join(", ")}`,
      at,
    );
    await write((doc) => {
      const current = doc.jobs.find((j) => j.id === job.id);
      if (!current || current.status !== "wave_draining") return { next: null, result: null };
      return { next: updateJob(doc, job.id, next), result: next.status };
    });
    await continueWave(next);
  }

  /** Apply the wave's next bot; the wave is sequential (one drain at a time). */
  async function continueWave(job: BotCanaryJob): Promise<void> {
    const current = (await store.read()).jobs.find((j) => j.id === job.id);
    if (!current || !isBotCanaryActive(current.status)) return;
    const pending = current.waveBotKeys.filter((botKey) => !current.doneBotKeys.includes(botKey));
    if (pending.length === 0) {
      const at = now();
      const next = appendBotCanaryStep(
        { ...current, status: "wave_restoring", updatedAt: at.toISOString() },
        "wave_restoring",
        "wave finished; checking the next wave",
        at,
      );
      await write((doc) => {
        const c = doc.jobs.find((j) => j.id === job.id);
        if (!c || c.status !== "wave_applying") return { next: null, result: null };
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
      return;
    }
    const botKey = pending[0];
    const agents = await deps.runtime.listAgents().catch(() => null);
    if (!agents) return;
    const agent = agents.find((a) => a.agentId === botKey);
    if (!agent) {
      // The bot vanished mid-rollout (deleted or turned off): skip it, the
      // sweep is the authority on who exists.
      const at = now();
      const next = appendBotCanaryStep(
        { ...current, status: "wave_applying", doneBotKeys: [...current.doneBotKeys, botKey], updatedAt: at.toISOString() },
        "wave_applying",
        `bot ${botKey} is not reconciled any more; skipped`,
        at,
      );
      await write((doc) => {
        const c = doc.jobs.find((j) => j.id === job.id);
        if (!c || (c.status !== "wave_draining" && c.status !== "wave_applying")) return { next: null, result: null };
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
      return;
    }
    const image = `${BOT_CANARY_IMAGE_REPOSITORY}@${current.digest}`;
    const at = now();
    const moved = appendBotCanaryStep(
      { ...current, status: "wave_applying", updatedAt: at.toISOString() },
      "wave_applying",
      `applying the new image to bot ${botKey}`,
      at,
    );
    await write((doc) => {
      const c = doc.jobs.find((j) => j.id === job.id);
      if (!c || (c.status !== "wave_draining" && c.status !== "wave_applying")) return { next: null, result: null };
      return { next: updateJob(doc, job.id, moved), result: moved.status };
    });
    const outcome = await deps.runtime.applyNow(agent, image, env);
    if (outcome.kind === "error") {
      await failOrRollback(job.id, "failed_health", `bot ${botKey} failed to apply the new image: ${outcome.message}`);
      return;
    }
    if (outcome.kind === "deferred") {
      return; // try the same bot on the next tick
    }
    const status = await deps.runtime.status(botKey).catch(() => null);
    if (status && (status.state === "unhealthy" || status.state === "stopped")) {
      await failOrRollback(job.id, "failed_health", `bot ${botKey} is '${status.state}' after the wave apply`);
      return;
    }
    const at2 = now();
    const done = appendBotCanaryStep(
      { ...moved, doneBotKeys: [...moved.doneBotKeys, botKey], updatedAt: at2.toISOString() },
      "wave_applying",
      `bot ${botKey} runs the new image (${status?.state ?? "state unknown"})`,
      at2,
    );
    await write((doc) => {
      const c = doc.jobs.find((j) => j.id === job.id);
      if (!c || c.status !== "wave_applying") return { next: null, result: null };
      return { next: updateJob(doc, job.id, done), result: done.status };
    });
  }

  /** After a wave: back to wave_draining for the next wave, or succeeded. */
  async function finishWave(job: BotCanaryJob): Promise<void> {
    const agents = await deps.runtime.listAgents().catch(() => null);
    if (!agents) return;
    const done = new Set(job.doneBotKeys);
    const remaining = agents.map((a) => a.agentId).filter((botKey) => !done.has(botKey));
    if (remaining.length === 0) {
      const at = now();
      const next = appendBotCanaryStep(
        { ...job, status: "succeeded", waveBotKeys: [], updatedAt: at.toISOString() },
        "succeeded",
        `rollout finished: ${job.doneBotKeys.length} bot(s) run ${BOT_CANARY_IMAGE_REPOSITORY}@${job.digest.slice(0, 19)}`,
        at,
      );
      await write((doc) => {
        const current = doc.jobs.find((j) => j.id === job.id);
        if (!current || current.status !== "wave_restoring") return { next: null, result: null };
        return { next: retireBotCanaryJob(updateJob(doc, job.id, next), job.id, at), result: next.status };
      });
      await auditFor(job, "succeeded", { actorType: "system", actorId: "myrmidon-bot-canary" }, { bots: job.doneBotKeys.length });
      return;
    }
    const at = now();
    const next = appendBotCanaryStep(
      { ...job, status: "wave_draining", waveBotKeys: [], updatedAt: at.toISOString() },
      "wave_draining",
      `planning the next wave (${remaining.length} bot(s) left)`,
      at,
    );
    await write((doc) => {
      const current = doc.jobs.find((j) => j.id === job.id);
      if (!current || current.status !== "wave_restoring") return { next: null, result: null };
      return { next: updateJob(doc, job.id, next), result: next.status };
    });
  }

  /**
   * The failure entry point (R5-C): with the automatic rollback on, a failed
   * rollout moves to `rolling_back` — the tick restores every bot that
   * received the new image to its own card image — and only then ends
   * `rolled_back`. With the rollback off (or nothing to restore) the rollout
   * ends `status` directly, the R5-B behavior.
   */
  async function failOrRollback(
    jobId: string,
    status: Extract<BotCanaryStatus, "aborted" | "failed_health" | "canary_failed" | "canary_smoke_failed">,
    reason: string,
  ) {
    if (settings.autoRollback && status !== "aborted") {
      const started = await startRollback(jobId, status, reason);
      if (started) return;
    }
    await failJob(jobId, status, reason);
  }

  /**
   * Move a failed rollout to `rolling_back` when at least one bot received
   * the new image. Returns false when there is nothing to restore (the
   * failure happened before any image switch) — the caller then ends the
   * rollout directly.
   */
  async function startRollback(jobId: string, failedStatus: BotCanaryStatus, reason: string): Promise<boolean> {
    const at = now();
    let moved: BotCanaryJob | null = null;
    await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || !isBotCanaryActive(job.status) || job.status === "rolling_back") return { next: null, result: null };
      const targets = botCanaryRollbackTargets(job);
      if (targets.length === 0) return { next: null, result: false as boolean };
      const next = appendBotCanaryStep(
        { ...job, status: "rolling_back", failureReason: reason, updatedAt: at.toISOString() },
        "rolling_back",
        `${failedStatus}: restoring ${targets.length} bot(s) to their card images (${targets.join(", ")})`,
        at,
      );
      moved = next;
      return { next: updateJob(doc, jobId, next), result: true };
    });
    if (!moved) return false;
    await auditFor(moved, "rolling_back", { actorType: "system", actorId: "myrmidon-bot-canary" }, { reason, failedStatus });
    return true;
  }

  /**
   * The rollback tick (R5-C): restore the next bot of the failed rollout to
   * its own card image, one at a time (the same discipline waves use — one
   * drain at a time). When the last bot is restored the rollout ends
   * `rolled_back` with the original failure reason kept. An apply error on a
   * rollback step ends the rollout `aborted` with the combined reason: the
   * sweep re-applies the card image on its next pass anyway, so the state
   * machine must not wedge — but the rollout must end, loudly.
   */
  async function continueRollback(job: BotCanaryJob): Promise<void> {
    const current = (await store.read()).jobs.find((j) => j.id === job.id);
    if (!current || current.status !== "rolling_back") return;
    const targets = botCanaryRollbackTargets(current);
    const pending = targets.filter((botKey) => !current.rolledBackBotKeys.includes(botKey));
    if (pending.length === 0) {
      const at = now();
      const next = appendBotCanaryStep(
        { ...current, status: "rolled_back", updatedAt: at.toISOString() },
        "rolled_back",
        `all touched bots restored to their card images: ${targets.join(", ")}`,
        at,
      );
      await write((doc) => {
        const c = doc.jobs.find((j) => j.id === job.id);
        if (!c || c.status !== "rolling_back") return { next: null, result: null };
        return { next: retireBotCanaryJob(updateJob(doc, job.id, next), job.id, at), result: next.status };
      });
      await auditFor(job, "rolled_back", { actorType: "system", actorId: "myrmidon-bot-canary" }, { reason: current.failureReason });
      return;
    }
    const botKey = pending[0];
    const agents = await deps.runtime.listAgents().catch(() => null);
    if (!agents) return; // the driver did not answer; the next tick retries
    const agent = agents.find((a) => a.agentId === botKey);
    if (!agent) {
      // The bot vanished mid-rollout: nothing to restore for it.
      const at = now();
      const next = appendBotCanaryStep(
        { ...current, rolledBackBotKeys: [...current.rolledBackBotKeys, botKey], updatedAt: at.toISOString() },
        "rolling_back",
        `bot ${botKey} is not reconciled any more; skipped`,
        at,
      );
      await write((doc) => {
        const c = doc.jobs.find((j) => j.id === job.id);
        if (!c || c.status !== "rolling_back") return { next: null, result: null };
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
      return;
    }
    const container = agent.adapterConfig?.container as Record<string, unknown> | undefined;
    const cardImage = typeof container?.image === "string" ? container.image.trim() : "";
    if (!cardImage) {
      // No card image to restore (a malformed card): skip with a loud step.
      const at = now();
      const next = appendBotCanaryStep(
        { ...current, rolledBackBotKeys: [...current.rolledBackBotKeys, botKey], updatedAt: at.toISOString() },
        "rolling_back",
        `bot ${botKey} has no card image to restore; skipped`,
        at,
      );
      await write((doc) => {
        const c = doc.jobs.find((j) => j.id === job.id);
        if (!c || c.status !== "rolling_back") return { next: null, result: null };
        return { next: updateJob(doc, job.id, next), result: next.status };
      });
      return;
    }
    const at = now();
    const applying = appendBotCanaryStep(
      { ...current, status: "rolling_back", updatedAt: at.toISOString() },
      "rolling_back",
      `restoring bot ${botKey} to its card image`,
      at,
    );
    await write((doc) => {
      const c = doc.jobs.find((j) => j.id === job.id);
      if (!c || c.status !== "rolling_back") return { next: null, result: null };
      return { next: updateJob(doc, job.id, applying), result: applying.status };
    });
    const outcome = await deps.runtime.applyNow(agent, cardImage, env);
    if (outcome.kind === "error") {
      await failJob(job.id, "aborted", `the automatic rollback could not restore bot ${botKey} to its card image: ${outcome.message} (the periodic sweep re-applies the card image; check the bot)`);
      return;
    }
    if (outcome.kind === "deferred") {
      return; // someone else's window; retry the same bot on a later tick
    }
    const at2 = now();
    const done = appendBotCanaryStep(
      { ...applying, rolledBackBotKeys: [...applying.rolledBackBotKeys, botKey], updatedAt: at2.toISOString() },
      "rolling_back",
      `bot ${botKey} restored to its card image`,
      at2,
    );
    await write((doc) => {
      const c = doc.jobs.find((j) => j.id === job.id);
      if (!c || c.status !== "rolling_back") return { next: null, result: null };
      return { next: updateJob(doc, job.id, done), result: done.status };
    });
  }

  async function failJob(jobId: string, status: Extract<BotCanaryStatus, "aborted" | "failed_health" | "canary_failed" | "canary_smoke_failed">, reason: string) {
    const at = now();
    const { result } = await write((doc) => {
      const job = doc.jobs.find((j) => j.id === jobId);
      if (!job || !isBotCanaryActive(job.status)) return { next: null, result: null as BotCanaryJob | null };
      const next = appendBotCanaryStep({ ...job, status, failureReason: reason, updatedAt: at.toISOString() }, status, reason, at);
      const retired = retireBotCanaryJob({ ...doc, jobs: doc.jobs.map((j) => (j.id === jobId ? next : j)) }, jobId, at);
      return { next: retired, result: next };
    });
    if (!result) return;
    await auditFor(result, status, { actorType: "system", actorId: "myrmidon-bot-canary" }, { reason });
  }

  return {
    current: currentView,
    preview,
    create,
    abort,
    tick,
  };
}

export type BotCanaryService = ReturnType<typeof botCanaryService>;
