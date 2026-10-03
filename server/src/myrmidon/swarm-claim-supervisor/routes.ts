// myrmidon(1.6-SWARM-CLAIM-B): the supervisor surface routes.
//
//   GET  /api/myrmidon/companies/:companyId/swarm-claim/supervisor/overview
//   POST /api/myrmidon/companies/:companyId/swarm-claim/supervisor/release-lease
//   GET  /api/myrmidon/companies/:companyId/swarm-claim/supervisor/pilot-report?from&to
//
// Reads need company access (the same check the vendor costs routes use);
// the rebalance action additionally needs a board actor — it moves live work.
// While part A's claim machinery is absent or off, the overview and the pilot
// report answer 503 with { enabled: false } so the UI can say why instead of
// showing a bare error.

import { Router, type Request, type Response, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { swarmSupervisorView, createSwarmSupervisorDbPort, type SwarmSupervisorOverview } from "./view.js";
import {
  createSwarmSupervisorReleasePort,
  releaseLeaseForRebalance,
  ClaimNotLiveError,
  ClaimNotFoundError,
  type SwarmRebalanceDeps,
} from "./rebalance.js";
import {
  createSwarmPilotDeps,
  swarmPilotReport,
  SwarmPilotNotEnabledError,
  SwarmPilotWindowError,
} from "./pilot-report.js";

export interface SwarmSupervisorRoutesDeps {
  db: Db;
  /** Board wake admission path; every limit and gate is enforced inside it. */
  enqueueWakeup: SwarmRebalanceDeps["enqueueWakeup"];
  /** Activity log for the rebalance action; absent in unit tests. */
  logActivity?: SwarmRebalanceDeps["logActivity"];
  env?: NodeJS.ProcessEnv;
  now(): Date;
}

export function swarmSupervisorRoutes(db: Db, deps: SwarmSupervisorRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const port = createSwarmSupervisorReleasePort(db, env);
  const view = swarmSupervisorView(port, env, now);
  const pilotDeps = createSwarmPilotDeps(db, env, now);

  router.get(
    "/myrmidon/companies/:companyId/swarm-claim/supervisor/overview",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const overview: SwarmSupervisorOverview = await view.overview(companyId);
      if (!overview.enabled) {
        res.status(503).json({ error: "swarm claim is not enabled", enabled: false });
        return;
      }
      res.json(overview);
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/swarm-claim/supervisor/release-lease",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const body = (req.body ?? {}) as { claimId?: unknown; reason?: unknown };
      if (typeof body.claimId !== "string" || !body.claimId.trim()) {
        res.status(400).json({ error: "claimId is required" });
        return;
      }
      try {
        const result = await releaseLeaseForRebalance(
          {
            port,
            enqueueWakeup: deps.enqueueWakeup,
            logActivity: deps.logActivity,
            env,
            now,
          },
          companyId,
          body.claimId.trim(),
          typeof body.reason === "string" ? body.reason : undefined,
          {
            actorType: req.actor?.type === "agent" ? "agent" : "user",
            actorId: req.actor?.type === "board" ? (req.actor.userId ?? "board") : (req.actor?.agentId ?? "board"),
          },
        );
        res.json(result);
      } catch (err) {
        if (err instanceof ClaimNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof ClaimNotLiveError) {
          res.status(409).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    },
  );

  router.get(
    "/myrmidon/companies/:companyId/swarm-claim/supervisor/pilot-report",
    async (req: Request, res: Response, next: NextFunction) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      try {
        const from = typeof req.query.from === "string" ? req.query.from : undefined;
        const to = typeof req.query.to === "string" ? req.query.to : undefined;
        const report = await swarmPilotReport(pilotDeps, companyId, from, to);
        res.json(report);
      } catch (err) {
        if (err instanceof SwarmPilotNotEnabledError) {
          res.status(503).json({ error: err.message, enabled: false });
          return;
        }
        if (err instanceof SwarmPilotWindowError) {
          res.status(400).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
