// server/src/myrmidon/swarm-claim/settings.ts
//
// myrmidon(1.6-SWARM): read and write `instance_settings.general.swarmClaim`.
//
// The precedence (stored settings, then environment, then the built-in default)
// is decided in `@paperclipai/shared`; this module is only the database half:
// it reads the raw row, hands it to the resolver, writes the canonical object
// back on a patch and logs the change. The same shape the RUNTIME-LIMITS and
// WORKSPACE-HYGIENE settings use, so an operator changes the pilot from the
// settings page or the API without a restart.

import type { Db } from "@paperclipai/db";
import {
  SWARM_CLAIM_SETTINGS_KEY,
  mergeSwarmClaimSettings,
  resolveSwarmClaimSettings,
  type ResolvedSwarmClaimSettings,
  type SwarmClaimSettingsPatch,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

/** Activity action written for every pilot settings change. */
export const SWARM_CLAIM_SETTINGS_UPDATED_ACTION = "instance.swarm_claim.updated";

export interface SwarmClaimSettingsPorts {
  /** The instance settings service (general block read/write). */
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral" | "updateGeneral">;
  /** Activity log; absent in unit tests. */
  logActivity?: (input: {
    companyId: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface SwarmClaimSettingsService {
  read(): Promise<ResolvedSwarmClaimSettings>;
  update(
    patch: SwarmClaimSettingsPatch,
    actor: { actorType: string; actorId: string },
  ): Promise<ResolvedSwarmClaimSettings>;
}

export function swarmClaimSettingsService(
  _db: Db,
  ports: SwarmClaimSettingsPorts,
): SwarmClaimSettingsService {
  const env = ports.env ?? process.env;

  async function read(): Promise<ResolvedSwarmClaimSettings> {
    const general = (await ports.settings.getGeneral()) as unknown as Record<string, unknown>;
    return resolveSwarmClaimSettings({ stored: general[SWARM_CLAIM_SETTINGS_KEY], env });
  }

  return {
    read,
    async update(patch, actor) {
      const current = await read();
      const next = mergeSwarmClaimSettings(current.settings, patch);
      await ports.settings.updateGeneral({ [SWARM_CLAIM_SETTINGS_KEY]: next });
      await ports.logActivity?.({
        companyId: "",
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: SWARM_CLAIM_SETTINGS_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: SWARM_CLAIM_SETTINGS_KEY,
        details: { settings: next },
      });
      return resolveSwarmClaimSettings({ stored: next, env });
    },
  };
}