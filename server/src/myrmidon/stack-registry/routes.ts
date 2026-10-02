// Stack registry (SUA): GET /api/myrmidon/stack, POST /api/myrmidon/stack/refresh
// and POST /api/myrmidon/stack/check.
//
// GET is read-only and returns the cached document (the seed view before the
// first refresh); any board user can read it. POST refresh rebuilds the local
// state (board build commit + Docker image digests reachable from the process);
// POST check runs the external release comparison (part B). Both are restricted
// to instance admins; agent keys get 403. A probe failure keeps the previous
// cache and answers 503 — a network outage never takes the board down.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { checkStackReleases, type StackCheckOptions } from "./check.js";
import { collectStackLocal, type CollectStackLocalOptions } from "./collector.js";
import { seedStackDocument, type StackDocument } from "./domain.js";
import { readStackDocument, writeStackDocument } from "./store.js";

export interface StackRegistryRouteOptions {
  collect?: CollectStackLocalOptions;
  check?: StackCheckOptions;
}

export function stackRegistryRoutes(db: Db, opts: StackRegistryRouteOptions = {}) {
  const router = Router();

  const currentView = async (): Promise<StackDocument> => {
    const stored = await readStackDocument(db);
    return stored.components.length > 0 ? stored : seedStackDocument();
  };

  router.get("/myrmidon/stack", async (_req, res) => {
    assertBoardOrgAccess(_req);
    res.json(await currentView());
  });

  router.post("/myrmidon/stack/refresh", async (_req, res) => {
    assertInstanceAdmin(_req);
    let next: StackDocument;
    try {
      const previous = await readStackDocument(db);
      next = await collectStackLocal({ ...opts.collect, previous });
    } catch (error) {
      // A broken probe must not take the board down: keep the previous cache
      // and report what happened.
      logger.error({ err: error }, "stack registry refresh failed");
      res.status(503).json({ error: "stack refresh failed", document: await currentView() });
      return;
    }
    await writeStackDocument(db, next);
    res.json(next);
  });

  router.post("/myrmidon/stack/check", async (_req, res) => {
    assertInstanceAdmin(_req);
    let next: StackDocument;
    try {
      next = await checkStackReleases(db, opts.check);
    } catch (error) {
      // No network (or any probe error): keep the previous cache intact.
      logger.error({ err: error }, "stack release check failed");
      res.status(503).json({ error: "stack check failed", document: await currentView() });
      return;
    }
    res.json(next);
  });

  return router;
}

/** Router for app.ts: GET /api/myrmidon/stack, POST /api/myrmidon/stack/refresh, POST /api/myrmidon/stack/check. */
export function myrmidonStackRegistryRoutes(db: Db) {
  return stackRegistryRoutes(db);
}