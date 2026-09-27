// GET/POST /api/myrmidon/maintenance — contract in docs/myrmidon/design/maintenance-mode.md §7.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { MAINTENANCE_ON_TIMEOUT, MAINTENANCE_SCOPE_TYPES, type MaintenanceScope } from "./domain.js";
import { MaintenanceError, type MaintenanceService } from "./service.js";
import { MAX_DRAIN_TIMEOUT_SEC } from "./settings.js";

const scopeSchema = z
  .object({
    type: z.enum(MAINTENANCE_SCOPE_TYPES),
    id: z.string().uuid().optional().nullable(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (scope.type === "instance" && scope.id) {
      ctx.addIssue({ code: "custom", message: "scope.id must be empty for the instance scope", path: ["id"] });
    }
    if (scope.type !== "instance" && !scope.id) {
      ctx.addIssue({ code: "custom", message: `scope.id is required for the ${scope.type} scope`, path: ["id"] });
    }
  });

export const maintenanceRequestSchema = z
  .object({
    action: z.enum(["enter", "exit"]),
    scope: scopeSchema,
    reason: z.string().trim().min(1).max(500).optional(),
    drainTimeoutSec: z.number().int().min(0).max(MAX_DRAIN_TIMEOUT_SEC).optional(),
    onTimeout: z.enum(MAINTENANCE_ON_TIMEOUT).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.action === "enter" && !body.reason) {
      ctx.addIssue({ code: "custom", message: "reason is required to enter maintenance", path: ["reason"] });
    }
  });

function toHttpError(err: unknown): unknown {
  if (!(err instanceof MaintenanceError)) return err;
  if (err.status === 404) return notFound(err.message);
  if (err.status === 409) return conflict(err.message);
  return badRequest(err.message);
}

export function maintenanceRoutes(_db: Db, service: MaintenanceService) {
  const router = Router();

  router.get("/myrmidon/maintenance", async (req, res) => {
    assertBoardOrgAccess(req);
    const scopeType = typeof req.query.scopeType === "string" ? req.query.scopeType : null;
    const scopeId = typeof req.query.scopeId === "string" ? req.query.scopeId : null;
    let filter: MaintenanceScope | undefined;
    if (scopeType) {
      const parsed = scopeSchema.safeParse(scopeType === "instance" ? { type: scopeType } : { type: scopeType, id: scopeId });
      if (!parsed.success) throw badRequest("Invalid scopeType or scopeId");
      filter = parsed.data;
    }
    res.json(await service.status(filter));
  });

  router.post("/myrmidon/maintenance", validate(maintenanceRequestSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof maintenanceRequestSchema>;
    const who = { actorType: actor.actorType, actorId: actor.actorId };
    try {
      if (body.action === "enter") {
        res.json(
          await service.enter(
            {
              scope: body.scope,
              reason: body.reason!,
              drainTimeoutSec: body.drainTimeoutSec,
              onTimeout: body.onTimeout,
            },
            who,
          ),
        );
      } else {
        res.json(await service.exit(body.scope, who, body.reason));
      }
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}
