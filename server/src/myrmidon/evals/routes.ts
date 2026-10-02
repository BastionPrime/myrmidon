// server/src/myrmidon/evals/routes.ts
//
// myrmidon(1.6-EVALS): the board-facing REST API.
//
//   GET  /api/myrmidon/companies/:companyId/evals/tasks?role
//   POST /api/myrmidon/companies/:companyId/evals/seed            (board only)
//   POST /api/myrmidon/companies/:companyId/evals/runs            (board only)
//   POST /api/myrmidon/companies/:companyId/evals/runs/:runId/confirm  (board only)
//   POST /api/myrmidon/companies/:companyId/evals/verdict         (board only)
//   GET  /api/myrmidon/companies/:companyId/evals/runs?role&limit
//   GET  /api/myrmidon/companies/:companyId/evals/runs/:runId
//
// Reads need company access; run mutations need a board actor (they spend
// real gateway calls). While the judge contour is not configured, reads
// still work and mutations answer 503 with the reason, so the board can say
// why the button is disabled instead of showing a bare 500.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/index.js";
import {
  createEvalsService,
  type EvalsService,
  type EvalRunInput,
} from "./service.js";
import { createJudge, DEFAULT_EVALS_MODEL, evalsSettingsProblem, readEvalsSettings, type EvalsSettings } from "./judge.js";
import { createLangfuseScoreExporter, noopScoreExporter, readLangfuseExportSettings } from "./langfuse.js";
import { ENGINEER_REFERENCE_TASKS, EVALS_PILOT_ROLE, seedReferenceTasks } from "./seed.js";
import { isEvalVerdict } from "./domain.js";

export interface EvalsRoutesDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Resolves the company secret named by MYRMIDON_EVALS_KEY_SECRET; null when missing. */
  readCompanyKey(companyId: string, secretName: string): Promise<string | null>;
  service?: EvalsService;
  now(): Date;
}

export const EVALS_ACTOR_ID = "myrmidon-evals";

function parseRunInput(body: unknown): EvalRunInput | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.role !== "string" || b.role.trim().length === 0) return { error: "role is required" };
  if (typeof b.subject !== "string" || b.subject.trim().length === 0) return { error: "subject is required" };
  if (typeof b.answers !== "object" || b.answers === null) return { error: "answers is required (task slug -> text)" };
  for (const [slug, value] of Object.entries(b.answers)) {
    if (typeof value !== "string") return { error: `answers["${slug}"] must be a string` };
  }
  let ciPassRate: number | null = null;
  if (b.ciPassRate !== undefined && b.ciPassRate !== null) {
    if (typeof b.ciPassRate !== "number" || !Number.isFinite(b.ciPassRate) || b.ciPassRate < 0 || b.ciPassRate > 100) {
      return { error: "ciPassRate must be a number 0-100" };
    }
    ciPassRate = b.ciPassRate;
  }
  if (b.baselineRunId !== undefined && b.baselineRunId !== null && typeof b.baselineRunId !== "string") {
    return { error: "baselineRunId must be a string" };
  }
  if (b.thresholdDrop !== undefined && b.thresholdDrop !== null) {
    if (typeof b.thresholdDrop !== "number" || !Number.isFinite(b.thresholdDrop) || b.thresholdDrop < 0 || b.thresholdDrop > 100) {
      return { error: "thresholdDrop must be a number 0-100" };
    }
  }
  return {
    companyId: "", // filled by the route
    role: b.role.trim(),
    subject: b.subject.trim(),
    answers: b.answers as Record<string, string>,
    ciPassRate,
    baselineRunId: typeof b.baselineRunId === "string" ? b.baselineRunId : null,
    thresholdDrop: typeof b.thresholdDrop === "number" ? b.thresholdDrop : undefined,
  };
}

export function myrmidonEvalsRoutes(db: Db, deps: Partial<EvalsRoutesDeps> = {}) {
  const router = Router();
  const env = deps.env ?? process.env;
  const settings = (): EvalsSettings => readEvalsSettings(env);
  const now = deps.now ?? (() => new Date());

  async function buildService(): Promise<{ service: EvalsService; problem: string | null }> {
    if (deps.service) return { service: deps.service, problem: null };
    const current = settings();
    const problem = evalsSettingsProblem(current);
    if (problem) {
      // Still return a service bound to a heuristic judge? No — mutations
      // must refuse instead of silently scoring with a fake. Reads only.
      return { service: createEvalsService(db, { judge: createJudge({ fetch: fetch, apiKey: "", baseUrl: "http://127.0.0.1:9", model: DEFAULT_EVALS_MODEL, timeoutMs: 1 }), model: current.model, now }), problem };
    }
    const readCompanyKey =
      deps.readCompanyKey ??
      (async (companyId: string, secretName: string) => {
        const secrets = secretService(db);
        const row = await secrets.getByName(companyId, secretName);
        if (!row) return null;
        return secrets.resolveSecretValue(companyId, row.id, "latest");
      });
    const key = current.keySecret ? await readCompanyKey("unknown-company", current.keySecret) : null;
    if (!key) {
      return {
        service: createEvalsService(db, { judge: createJudge({ fetch: fetch, apiKey: "", baseUrl: "http://127.0.0.1:9", model: DEFAULT_EVALS_MODEL, timeoutMs: 1 }), model: current.model, now }),
        problem: `the evals API key secret "${current.keySecret ?? "—"}" is not available`,
      };
    }
    const exporter = current.langfuseExport
      ? (() => {
          const lf = readLangfuseExportSettings(env);
          return lf.enabled && lf.baseUrl && lf.publicKey
            ? createLangfuseScoreExporter({ fetch: deps.fetch ?? fetch, baseUrl: lf.baseUrl, publicKey: lf.publicKey, timeoutMs: lf.timeoutMs })
            : noopScoreExporter;
        })()
      : noopScoreExporter;
    return {
      service: createEvalsService(db, {
        judge: createJudge({
          fetch: deps.fetch ?? fetch,
          apiKey: key,
          baseUrl: current.baseUrl!,
          model: current.model,
          timeoutMs: current.timeoutMs,
        }),
        exporter,
        model: current.model,
        now,
      }),
      problem: null,
    };
  }

  router.get("/myrmidon/companies/:companyId/evals/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const role = typeof req.query.role === "string" ? req.query.role : EVALS_PILOT_ROLE;
    const { service } = await buildService();
    const tasks = await service.loadTasks(companyId, role);
    res.json({ role, count: tasks.length, tasks });
  });

  router.post("/myrmidon/companies/:companyId/evals/seed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const role = typeof req.body?.role === "string" && req.body.role.trim() ? req.body.role.trim() : EVALS_PILOT_ROLE;
    const result = await seedReferenceTasks(db, companyId, role, ENGINEER_REFERENCE_TASKS);
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: EVALS_ACTOR_ID,
      action: "evals.seeded",
      entityType: "eval_reference_tasks",
      entityId: role,
      details: { ...result },
    });
    res.json(result);
  });

  router.post("/myrmidon/companies/:companyId/evals/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = parseRunInput(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { service, problem } = await buildService();
    if (problem) {
      res.status(503).json({ error: problem, enabled: false });
      return;
    }
    try {
      const outcome = await service.runEval({ ...parsed, companyId });
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: EVALS_ACTOR_ID,
        action: "evals.run_completed",
        entityType: "eval_run",
        entityId: outcome.run.id,
        details: {
          role: outcome.run.role,
          subject: outcome.run.subject,
          verdict: outcome.run.verdict,
          scorePercent: outcome.run.scores?.scorePercent ?? null,
          needsConfirm: outcome.needsConfirm,
        },
      });
      res.json(outcome);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.post("/myrmidon/companies/:companyId/evals/runs/:runId/confirm", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const { service, problem } = await buildService();
    if (problem) {
      res.status(503).json({ error: problem, enabled: false });
      return;
    }
    const answers =
      typeof req.body?.answers === "object" && req.body.answers !== null ? (req.body.answers as Record<string, string>) : undefined;
    try {
      const outcome = await service.runConfirmation(req.params.runId as string, answers);
      if (outcome.run.companyId !== companyId) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: EVALS_ACTOR_ID,
        action: "evals.run_confirmed",
        entityType: "eval_run",
        entityId: outcome.run.id,
        details: {
          role: outcome.run.role,
          subject: outcome.run.subject,
          verdict: outcome.run.verdict,
          scorePercent: outcome.run.scores?.scorePercent ?? null,
        },
      });
      res.json(outcome);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.post("/myrmidon/companies/:companyId/evals/verdict", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.role !== "string" || typeof b.subject !== "string" || typeof b.baselineRunId !== "string") {
      res.status(400).json({ error: "role, subject and baselineRunId are required" });
      return;
    }
    const { service } = await buildService();
    try {
      const verdict = await service.verdictForCandidate({
        companyId,
        role: b.role,
        subject: b.subject,
        baselineRunId: b.baselineRunId,
        thresholdDrop: typeof b.thresholdDrop === "number" ? b.thresholdDrop : undefined,
      });
      res.json(verdict);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  router.get("/myrmidon/companies/:companyId/evals/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;
    const { service } = await buildService();
    const runs = await service.listRuns(companyId, role, limit);
    res.json({ runs });
  });

  router.get("/myrmidon/companies/:companyId/evals/runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { service } = await buildService();
    const run = await service.getRun(companyId, req.params.runId as string);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ run });
  });

  return router;
}
