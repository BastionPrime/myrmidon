// server/src/myrmidon/agent-memory/routes.ts
//
// myrmidon(MEMORY-UI): the API behind the "Memory" tab of the agent card.
//
//   GET    /api/myrmidon/agents/:id/memory                — status (bank, enabled)
//   GET    /api/myrmidon/agents/:id/memory/memories       — list (limit/offset/state)
//   GET    /api/myrmidon/agents/:id/memory/export         — full bank as JSON
//   DELETE /api/myrmidon/agents/:id/memory/memories/:mid  — invalidate one unit
//   POST   /api/myrmidon/agents/:id/memory/clear          — clear the whole bank
//
// Board actors only, with company access: the memory of a bot is operator
// territory (the agent itself cannot scrub its own memory — same rule as the
// bot-container routes). Every mutation and the export write an activity log
// row inside the service. A malformed agent id is "not found", and another
// company's agent is indistinguishable from a missing one.
//
// While the instance switch is off, status still answers (so the tab can say
// why) and the data routes answer 503 with `enabled: false`.

import { Router, type Request } from "express";
import { z } from "zod";
import { forbidden, HttpError, notFound } from "../../errors.js";
import { getActorInfo } from "../../routes/authz.js";
import { validate } from "../../middleware/validate.js";
import {
  agentMemoryService,
  MemoryUiError,
  type MemoryServiceDeps,
} from "./service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalidateSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

function toHttpError(err: unknown): unknown {
  if (err instanceof MemoryUiError) {
    // 503 keeps the "not enabled" contract the M2-A routes use; upstream
    // memory-service errors (4xx/502) surface as their own status.
    const status = err.status === 503 ? 503 : err.status >= 400 && err.status < 600 ? err.status : 502;
    return new HttpError(status, err.message);
  }
  return err;
}

export interface MemoryRoutesAgent {
  id: string;
  companyId: string;
}

export interface MemoryRoutesDeps {
  deps: MemoryServiceDeps;
  /** The stored agent row, or null. */
  getAgent(id: string): Promise<MemoryRoutesAgent | null>;
  /** Company access check (same rule as the bot-container routes). */
  hasCompanyAccess(req: Request, companyId: string): boolean;
  /** Board-only gate; throws to deny. */
  assertBoard(req: Request): void;
}

export function agentMemoryRoutes(input: MemoryRoutesDeps) {
  const router = Router();
  const service = agentMemoryService(input.deps);

  /** 404 for "no such agent" and "someone else's agent", so ids cannot be probed. */
  async function loadAgent(req: Request): Promise<MemoryRoutesAgent> {
    const id = req.params.id as string;
    const agent = UUID_PATTERN.test(id) ? await input.getAgent(id) : null;
    // Cross-company indistinguishability BEFORE the permission checks: a
    // caller without this company's access must not learn the agent exists.
    if (!agent || !input.hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    input.assertBoard(req);
    return agent;
  }

  function actorOf(req: Request) {
    const actor = getActorInfo(req);
    return {
      actorType: actor.actorType as "agent" | "user",
      actorId: actor.actorId,
      agentId: actor.actorType === "agent" ? actor.agentId : null,
    };
  }

  router.get("/myrmidon/agents/:id/memory", async (req, res) => {
    const agent = await loadAgent(req);
    res.json(await service.status(agent.id, agent.companyId));
  });

  router.get("/myrmidon/agents/:id/memory/memories", async (req, res) => {
    const agent = await loadAgent(req);
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const state = typeof req.query.state === "string" && req.query.state.trim() ? req.query.state.trim() : undefined;
    try {
      res.json(await service.list(agent.id, agent.companyId, { limit, offset, state }));
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get("/myrmidon/agents/:id/memory/export", async (req, res) => {
    const agent = await loadAgent(req);
    try {
      const payload = await service.exportBank(agent.id, agent.companyId, actorOf(req));
      res.setHeader("Content-Disposition", `attachment; filename="agent-${agent.id}-memory.json"`);
      res.json(payload);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.delete("/myrmidon/agents/:id/memory/memories/:mid", validate(invalidateSchema), async (req, res) => {
    const agent = await loadAgent(req);
    const body = req.body as z.infer<typeof invalidateSchema>;
    try {
      await service.invalidate(agent.id, agent.companyId, req.params.mid as string, body.reason, actorOf(req));
      res.json({ deleted: true });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/agents/:id/memory/clear", async (req, res) => {
    const agent = await loadAgent(req);
    try {
      const result = await service.clearBank(agent.id, agent.companyId, actorOf(req));
      res.json({ cleared: true, deletedCount: result.deletedCount });
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.floor(value);
  if (clamped < min || clamped > max) return fallback;
  return clamped;
}

/** Guard used by tests: a plain express route table with the real asserters. */
export function memoryRouteAsserters() {
  return {
    assertBoard(req: Request): void {
      if (req.actor?.type !== "board") throw forbidden("Board access required");
    },
    assertCompanyAccess(req: Request, companyId: string): void {
      if (req.actor?.type === "agent" && req.actor.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
    },
  };
}
