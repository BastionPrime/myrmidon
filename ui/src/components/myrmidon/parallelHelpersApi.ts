// Parallel helpers (myrmidon PARALLEL-HELPERS): GET/PATCH /api/myrmidon/parallel-helpers.
//
// The company ceiling and default for the "Parallel helpers" block on agent
// cards, plus the capacity hint (a warning, never a block). The profile
// compiler re-reads the row every reconcile tick, so a change applies within
// one tick without a restart.
import type { ParallelHelpersSettings, HelperCapacityHint } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface ParallelHelpersView {
  settings: ParallelHelpersSettings;
  effective: {
    ceiling: number;
    defaultPerAgent: number;
  };
  capacity: HelperCapacityHint;
}

export const parallelHelpersQueryKey = ["myrmidon", "parallel-helpers"] as const;

export const parallelHelpersApi = {
  get: () => api.get<ParallelHelpersView>("/myrmidon/parallel-helpers"),
  update: (patch: Partial<ParallelHelpersSettings>) =>
    api.patch<ParallelHelpersView>("/myrmidon/parallel-helpers", patch),
};
