// server/src/myrmidon/tracing-health/index.ts
//
// myrmidon(TRACING-HEALTH): re-exports and the app.ts wiring point.
// GET /api/myrmidon/tracing/health — see routes.ts and domain.ts.

export { myrmidonTracingHealthRoutes, tracingHealthRoutes } from "./routes.js";
export type { TracingHealthRoutesDeps } from "./routes.js";
export {
  CALLBACK_ERROR_RATE_THRESHOLD,
  computeTracingHealthState,
  REASONS,
  type TracingHealthEvidence,
  type TracingHealthReport,
  type TracingHealthState,
  type TracingHealthWindow,
} from "./domain.js";
export { readTracingHealthSettings } from "./probes.js";
export type { TracingHealthSettings } from "./probes.js";
export { TRACING_HEALTH_SOURCE_KIND, tracingHealthAttentionItem, tracingHealthAttentionItems } from "./attention.js";
export {
  createTracingHealthAttentionProbe,
  myrmidonTracingHealthAttentionProbe,
  probeTracingHealthReport,
} from "./attention-probe.js";
export type { TracingHealthProbeDeps } from "./attention-probe.js";
