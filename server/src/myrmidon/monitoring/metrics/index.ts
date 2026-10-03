// server/src/myrmidon/monitoring/metrics/index.ts
//
// myrmidon(1.7-METRICS): the wiring point of the Prometheus endpoint.
//
// app.ts mounts the router from here at the origin root — the same
// outside-/api shape the swarm-claim ingress uses. The router is stateless:
// every scrape collects its numbers on the fly from the existing tables and
// the in-process attention registries; there is no timer, no store and no
// migration behind this module.

import type { Db } from "@paperclipai/db";
import { myrmidonMetricsRoutes, type MetricsRoutesDeps } from "./routes.js";

export * from "./metrics.js";
export {
  METRICS_TOKEN_SECRET_ENV,
  METRICS_TOKEN_ENV,
  METRICS_ERROR_WINDOW_ENV,
  METRICS_LATENCY_WINDOW_ENV,
  myrmidonMetricsRoutes,
  resolveMetricsToken,
  tokenMatches,
  type MetricsRoutesDeps,
} from "./routes.js";

/** The router app.ts mounts (origin root, outside /api). */
export function myrmidonMetricsApp(db: Db): ReturnType<typeof myrmidonMetricsRoutes> {
  return myrmidonMetricsRoutes({ db, env: process.env, now: () => new Date() });
}
