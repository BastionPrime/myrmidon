// myrmidon(SC1): console routes.
//
//   GET  /api/myrmidon/fleet/servers            — the company's console registry
//   PUT  /api/myrmidon/fleet/servers            — register or replace one row
//   POST /api/myrmidon/fleet/console-token      — signed auth-JSON for one row
//   POST /api/myrmidon/fleet/console-sessions/close — close a session, journal the duration
//
// Only the company owner reaches these routes. The instance-wide board identity
// (local implicit access or an instance admin) keeps full-control operator
// access, the same way the panel treats it elsewhere.

import { Router, type Request } from "express";
import { z } from "zod";
import { forbidden, HttpError } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import {
  CONSOLE_DEFAULT_PROTOCOL_PORT,
  FLEET_CONSOLE_DEFAULT_USERNAME,
  FLEET_CONSOLE_PROTOCOLS,
  FLEET_SERVER_SLUG_PATTERN,
  type FleetServerInput,
} from "./domain.js";
import { ConsoleError, type ConsoleService } from "./service.js";

export function assertFleetConsoleOwner(req: Request, companyId: string): void {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (membership?.status === "active" && membership.membershipRole === "owner") return;
  throw forbidden("Company owner access required");
}

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/\s/.test(value), "hostname must not contain whitespace");

export const fleetServerSchema = z
  .object({
    companyId: z.string().uuid(),
    slug: z.string().trim().regex(FLEET_SERVER_SLUG_PATTERN),
    name: z.string().trim().min(1).max(120),
    hostname: hostnameSchema,
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(FLEET_CONSOLE_PROTOCOLS).optional(),
    username: z.string().trim().min(1).max(64).optional(),
    passwordSecretKey: z.string().trim().min(1).max(120).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const consoleTokenRequestSchema = z
  .object({
    companyId: z.string().uuid(),
    serverId: z.string().uuid().optional(),
    slug: z.string().trim().min(1).max(63).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Boolean(body.serverId) === Boolean(body.slug)) {
      ctx.addIssue({ code: "custom", message: "give exactly one of serverId or slug", path: ["serverId"] });
    }
  });

export const consoleSessionCloseSchema = z
  .object({
    companyId: z.string().uuid(),
    sessionId: z.string().uuid(),
  })
  .strict();

function toHttpError(err: unknown): unknown {
  if (!(err instanceof ConsoleError)) return err;
  return new HttpError(err.status, err.message, { code: err.code });
}

export function fleetConsoleRoutes(deps: { service: ConsoleService }) {
  const router = Router();

  router.get("/myrmidon/fleet/servers", async (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) throw new HttpError(400, "companyId is required");
    assertFleetConsoleOwner(req, companyId);
    res.json({ servers: await deps.service.listServers(companyId) });
  });

  router.put("/myrmidon/fleet/servers", validate(fleetServerSchema), async (req, res) => {
    const body = req.body as z.infer<typeof fleetServerSchema>;
    assertFleetConsoleOwner(req, body.companyId);
    const protocol = body.protocol ?? "ssh";
    const input: FleetServerInput = {
      slug: body.slug,
      name: body.name,
      hostname: body.hostname,
      port: body.port ?? CONSOLE_DEFAULT_PROTOCOL_PORT[protocol],
      protocol,
      username: body.username ?? FLEET_CONSOLE_DEFAULT_USERNAME,
      passwordSecretKey: body.passwordSecretKey ?? null,
      description: body.description ?? null,
      enabled: body.enabled ?? true,
    };
    res.json({ server: await deps.service.upsertServer(body.companyId, input) });
  });

  router.post("/myrmidon/fleet/console-token", validate(consoleTokenRequestSchema), async (req, res) => {
    const body = req.body as z.infer<typeof consoleTokenRequestSchema>;
    assertFleetConsoleOwner(req, body.companyId);
    const actor = getActorInfo(req);
    try {
      res.json(
        await deps.service.issueConsoleToken({
          companyId: body.companyId,
          serverId: body.serverId ?? null,
          slug: body.slug ?? null,
          actor: { actorType: actor.actorType, actorId: actor.actorId },
        }),
      );
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/fleet/console-sessions/close", validate(consoleSessionCloseSchema), async (req, res) => {
    const body = req.body as z.infer<typeof consoleSessionCloseSchema>;
    assertFleetConsoleOwner(req, body.companyId);
    const actor = getActorInfo(req);
    try {
      res.json(
        await deps.service.closeConsoleSession({
          companyId: body.companyId,
          sessionId: body.sessionId,
          actor: { actorType: actor.actorType, actorId: actor.actorId },
        }),
      );
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}