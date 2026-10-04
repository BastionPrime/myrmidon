// Swarm claim pilot settings (myrmidon 1.6.1, SWARM-SETTINGS-UI):
// GET/PATCH /api/myrmidon/swarm-claim.
//
// The pilot parameters of the per-role queues — the master switch, the
// role/company pilot set, the lease TTL, the per-agent ceiling, the sweep
// interval and the P0 preemption — are instance settings the server reads on
// every use. Saving here applies them without a restart: a free agent claims
// the top task of its role's queue within one wake, and switching the pilot
// off frees the live leases at once. The environment variables remain forced
// overrides; `sources` says per key whether the UI value or the override is
// in force, and the panel renders exactly that.
import type {
  SwarmClaimSettings,
  SwarmClaimSettingsPatch,
  SwarmClaimSettingKey,
  SwarmClaimSettingSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

/** One journal entry: who changed what, and when. */
export interface SwarmClaimJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  patch: SwarmClaimSettingsPatch;
}

export interface SwarmClaimSettingsView {
  settings: SwarmClaimSettings;
  sources: Record<SwarmClaimSettingKey, SwarmClaimSettingSource>;
  /** The change journal, newest first. */
  journal: SwarmClaimJournalEntry[];
  /** How many live leases a disable freed (PATCH response only). */
  releasedClaims?: number;
}

export const swarmClaimSettingsQueryKey = ["myrmidon", "swarm-claim", "settings"] as const;

export const swarmClaimSettingsApi = {
  get: () => api.get<SwarmClaimSettingsView>("/myrmidon/swarm-claim"),
  update: (patch: SwarmClaimSettingsPatch) =>
    api.patch<SwarmClaimSettingsView>("/myrmidon/swarm-claim", patch),
};

export function describeSwarmClaimSource(source: SwarmClaimSettingSource | undefined): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Environment override";
    default:
      return "Default";
  }
}
