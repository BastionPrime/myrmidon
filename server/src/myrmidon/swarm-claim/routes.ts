// server/src/myrmidon/swarm-claim/routes.ts
//
// myrmidon(1.6-SWARM): the agent-facing and board-facing core API.
//
// - POST /api/myrmidon/companies/:companyId/swarm-claim/claim — the agent takes
//   the top task of its role's queue behind a lease. Agent-authenticated; the
//   per-agent ceiling and the P0 order apply inside the service.
// - POST .../swarm-claim/heartbeat — the run refreshes its own lease.
// - GET/PATCH /api/myrmidon/swarm-claim — the pilot settings (the flag, the
//   TTL, the ceiling, the sweep interval), the same read/write rule the other
//   instance settings follow: any board member reads, instance-admin writes.
//
// The queues/leases overview GET is deliberately NOT here: the operator split
// the 1.6 epic into two parts and the supervisor view belongs to the second
// (OPE-3609, swarm-claim-supervisor/). This file owns the claim side only.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchSwarmClaimSettingsSchema, type SwarmClaimSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { z } from "zod";
import {
  claimNextTaskForAgent,
  refreshLeaseForRun,
  type SwarmClaimServicePorts,
} from "./service.js";
import type { swarmClaimSettingsService } from "./settings.js";

const claimBodySchema = z
  .object({
    /** The issue to claim; when absent the service takes the queue's top task. */
    issueId: z.string().uuid().optional(),
    /** The run the claim is for (the checkout path passes it). */
    runId: z.string().uuid().nullish(),
    /** The agent a board actor claims on behalf of (agents pass their own id implicitly). */
    agentId: z.string().uuid().optional(),
  })
  .strict();

const heartbeatBodySchema = z
  .object({
    issueId: z.string().uuid(),
    /** The agent a board actor refreshes on behalf of (agents use their own lease). */
    agentId: z.string().uuid().optional(),
  })
  .strict();

export function swarmClaimRoutes(
  db: Db,
  ports: SwarmClaimServicePorts,
  settingsService: ReturnType<typeof swarmClaimSettingsService>,
) {
  const router = Router();

  router.post(
    "/myrmidon/companies/:companyId/swarm-claim/claim",
    validate(claimBodySchema),
    async (req, res) => {
      // myrmidon(1.6-SWARM): an agent claims for itself; a board actor may act
      // on behalf of an agent but the company boundary is enforced either way.
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const agentId =
        actor.actorType === "agent" ? actor.actorId : (req.body as { agentId?: string }).agentId;
      if (!agentId || typeof agentId !== "string") {
        res.status(401).json({ error: "Agent authentication required to claim a task" });
        return;
      }
      const outcome = await claimNextTaskForAgent(ports, {
        companyId,
        agentId,
        runId: (req.body as { runId?: string | null }).runId ?? null,
      });
      if (outcome.reason === "disabled") {
        res.status(503).json({ enabled: false, reason: outcome.reason });
        return;
      }
      res.json(outcome);
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/swarm-claim/heartbeat",
    validate(heartbeatBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const agentId =
        actor.actorType === "agent" ? actor.actorId : (req.body as { agentId?: string }).agentId;
      if (!agentId || typeof agentId !== "string") {
        res.status(401).json({ error: "Agent authentication required to refresh a lease" });
        return;
      }
      const refreshed = await refreshLeaseForRun(ports, {
        companyId,
        agentId,
        issueId: (req.body as { issueId: string }).issueId,
      });
      res.json({ refreshed });
    },
  );

  router.get("/myrmidon/swarm-claim", async (req, res) => {
    assertBoardOrgAccess(req);
    const [resolved, journal] = await Promise.all([settingsService.read(), settingsService.journal()]);
    res.json({ ...resolved, journal });
  });

  router.patch(
    "/myrmidon/swarm-claim",
    validate(patchSwarmClaimSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const patch = req.body as SwarmClaimSettingsPatch;
      const resolved = await settingsService.update(patch, {
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      // 1.6.1 (SWARM-SETTINGS-UI): a switch-off frees the live leases now, not
      // at the next sweep tick — the acceptance criterion is "выключение
      // действует сразу". Best-effort: a failure here leaves the release to
      // the sweep's disable pass, so it never fails the request itself.
      let releasedClaims = 0;
      if (resolved.settings.enabled === false) {
        try {
          releasedClaims = await releaseAllLiveClaimRows(db, new Date());
        } catch {
          releasedClaims = 0;
        }
      }
      res.json({ ...resolved, releasedClaims });
    },
  );

  return router;
}

/**
 * 1.6.1 (SWARM-SETTINGS-UI): the disable path of PATCH — release every live
 * claim with the reason recorded, bounded to one page per call. Exported from
 * the sweep module's reason constant; the sweep repeats this on its next pass
 * for anything the request missed (a table that did not exist yet, a failure).
 */
async function releaseAllLiveClaimRows(db: Db, now: Date): Promise<number> {
  const { swarmClaimTableReady, listAllLiveClaims, releaseClaim } = await import("./store.js");
  const { logActivity } = await import("../../services/activity-log.js");
  const { SWARM_CLAIM_RELEASE_REASON_DISABLED } = await import("./sweep.js");
  const { SWARM_CLAIM_RELEASED_ACTION } = await import("@paperclipai/shared");
  if (!(await swarmClaimTableReady(db))) return 0;
  const rows = await listAllLiveClaims(db, 200);
  let released = 0;
  for (const row of rows) {
    const ok = await releaseClaim(db, {
      claimId: row.id,
      reason: SWARM_CLAIM_RELEASE_REASON_DISABLED,
      now,
    });
    if (!ok) continue;
    released += 1;
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "swarm_claim_settings",
      agentId: row.agentId,
      runId: row.runId,
      action: SWARM_CLAIM_RELEASED_ACTION,
      entityType: "issue",
      entityId: row.issueId,
      details: { reason: SWARM_CLAIM_RELEASE_REASON_DISABLED, claimId: row.id },
    }).catch(() => undefined);
  }
  return released;
}