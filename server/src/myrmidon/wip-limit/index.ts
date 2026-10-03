// server/src/myrmidon/wip-limit/index.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the wiring point of the per-agent WIP limit.
//
// app.ts mounts `wipLimitRoutes` from here; the startup in index.ts ticks the
// sweeper on the heartbeat scheduler (the same place the swarm-claim sweep
// lives). The shared contract (settings shape, limit resolver, status rows)
// lives in `@paperclipai/shared` so part B (the UI) reads the same decisions
// this module enforces.

import type { Db } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { wipLimitRoutes } from "./routes.js";
import { createWipLimitSweeper, type WipLimitSweeper } from "./sweep.js";

export * from "./status.js";
export * from "./attention.js";
export * from "./signal.js";
export * from "./settings.js";
export { wipLimitRoutes, wipLimitAddCommentPort } from "./routes.js";
export { createWipLimitSweeper, wipLimitsAllDisabled } from "./sweep.js";
export type { WipLimitSweeper, WipLimitSweeperDeps, WipLimitSweepResult } from "./sweep.js";

/** Router for app.ts: settings and status over the fixed contract. */
export function myrmidonWipLimitRoutes(db: Db) {
  return wipLimitRoutes(db);
}

/** The sweeper the startup ticks; the comment port is the issue service. */
export function buildWipLimitSweeper(db: Db): WipLimitSweeper {
  const svc = issueService(db);
  return createWipLimitSweeper({
    db,
    settings: instanceSettingsService(db),
    addComment: (issueId, body, options) =>
      svc.addComment(issueId, body, {}, {
        authorType: "system",
        presentation: options?.presentation,
        metadata: options?.metadata,
      }),
  });
}
