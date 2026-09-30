// myrmidon(ABOUT): GET /api/myrmidon/about — product name, release version and
// build metadata for the "About Myrmidon" settings section and the sidebar
// footer. Read-only; board and agent actors may read it (the same health
// details rule), anonymous callers get 403: the version is already public via
// the health route, but this surface is UI support, not a public probe.
import { Router } from "express";
import { assertBoardOrAgent } from "../../routes/authz.js";
import { readAboutBuildInfo } from "./build-info.js";

export function aboutRoutes(): Router {
  const router = Router();
  router.get("/myrmidon/about", (_req, res) => {
    assertBoardOrAgent(_req);
    res.json(readAboutBuildInfo());
  });
  return router;
}
