// Stack registry (SUA): GET /api/myrmidon/stack and POST /api/myrmidon/stack/refresh.
//
// GET is read-only and returns the cached document (the seed view before the
// first refresh); any board user can read it. POST refresh rebuilds the local
// state (board build commit + Docker image digests reachable from the process)
// and is restricted to instance admins; agent keys get 403. External release
// data is part B and is never fetched here.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { collectStackLocal, type CollectStackLocalOptions } from "./collector.js";
import { STACK_SEED, type StackDocument, type StackSnapshot } from "./domain.js";
import { readStackDocument, writeStackDocument } from "./store.js";

function seedView(): StackDocument {
  return {
    version: 1,
    refreshedAt: null,
    components: STACK_SEED.map((seed) => ({
      version: 1 as const,
      name: seed.name,
      releaseSource: seed.releaseSource,
      upstream: seed.upstream,
      localProbe: seed.localProbe,
      ...(seed.note ? { note: seed.note } : {}),
      local: {
        version: null,
        commit: null,
        digest: null,
        runningOn: null,
        unknownReason: "not refreshed yet",
        checkedAt: null,
        patches: [],
      },
    })),
  };
}

export function stackRegistryRoutes(
  db: Db,
  opts: { collect?: CollectStackLocalOptions } = {},
) {
  const router = Router();

  router.get("/myrmidon/stack", async (_req, res) => {
    assertBoardOrgAccess(_req);
    const stored = await readStackDocument(db);
    res.json(stored.components.length > 0 ? stored : seedView());
  });

  router.post("/myrmidon/stack/refresh", async (_req, res) => {
    assertInstanceAdmin(_req);
    let next: StackDocument;
    try {
      next = await collectStackLocal(opts.collect);
    } catch (error) {
      // A broken probe must not take the board down: keep the previous cache
      // and report what happened.
      logger.error({ err: error }, "stack registry refresh failed");
      const stored = await readStackDocument(db);
      const view = stored.components.length > 0 ? stored : seedView();
      res.status(503).json({ error: "stack refresh failed", document: view });
      return;
    }
    await writeStackDocument(db, next);
    res.json(next);
  });

  return router;
}

/** Router for app.ts: GET /api/myrmidon/stack, POST /api/myrmidon/stack/refresh. */
export function myrmidonStackRegistryRoutes(db: Db) {
  return stackRegistryRoutes(db);
}

export type { StackSnapshot };
