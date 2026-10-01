// Runtime run admission limits (myrmidon C0, RUNTIME-LIMITS):
// GET/PATCH /api/myrmidon/runtime-limits.
//
// The values cap how many agent runs this server starts at once, how fast it
// starts them, and how much memory it keeps free; PATCH saves them to the
// instance settings and they apply immediately, without restarting the server.
import type { RunLimits, RunLimitsPatch, RunLimitsSource, RunLimitKey } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface RuntimeLimitsView {
  limits: RunLimits;
  sources: Record<RunLimitKey, RunLimitsSource>;
}

export const runtimeLimitsQueryKey = ["myrmidon", "runtime-limits"] as const;

export const runtimeLimitsApi = {
  get: () => api.get<RuntimeLimitsView>("/myrmidon/runtime-limits"),
  update: (patch: RunLimitsPatch) => api.patch<RuntimeLimitsView>("/myrmidon/runtime-limits", patch),
};

export function describeRunLimitSource(source: RunLimitsSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}