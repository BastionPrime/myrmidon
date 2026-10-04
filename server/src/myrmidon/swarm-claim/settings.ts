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
//
// 1.6.1 (SWARM-SETTINGS-UI): the change journal. Every update appends a
// capped, newest-first list of { at, actorType, actorId, patch } entries under
// `general.swarmClaimJournal`, read back by GET /api/myrmidon/swarm-claim so
// the settings screen can answer "who turned this on, and when". The activity
// log row stays the audit trail; the journal is the UI-facing view of it that
// works without a company scope (instance settings are instance-wide).

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

/** Stored-settings key of the change journal inside `general`. */
export const SWARM_CLAIM_JOURNAL_KEY = "swarmClaimJournal";
/** Entries kept in the journal; older ones fall off the front. */
export const SWARM_CLAIM_JOURNAL_LIMIT = 50;

/** One journal entry: who changed what, and when. */
export interface SwarmClaimJournalEntry {
  at: string;
  actorType: string;
  actorId: string;
  /** The keys the actor changed, with their new values. */
  patch: SwarmClaimSettingsPatch;
}

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
  /** The change journal, newest first; empty when nothing was ever changed. */
  journal(): Promise<SwarmClaimJournalEntry[]>;
}

type GeneralRecord = Record<string, unknown>;

function asGeneral(value: unknown): GeneralRecord {
  return typeof value === "object" && value !== null ? (value as GeneralRecord) : {};
}

function readJournal(raw: unknown): SwarmClaimJournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SwarmClaimJournalEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as GeneralRecord;
    if (
      typeof record.at !== "string" ||
      typeof record.actorType !== "string" ||
      typeof record.actorId !== "string" ||
      typeof record.patch !== "object" ||
      record.patch === null
    ) {
      continue;
    }
    entries.push({
      at: record.at,
      actorType: record.actorType,
      actorId: record.actorId,
      patch: record.patch as SwarmClaimSettingsPatch,
    });
  }
  return entries;
}

function appendJournal(
  existing: SwarmClaimJournalEntry[],
  entry: SwarmClaimJournalEntry,
): SwarmClaimJournalEntry[] {
  return [entry, ...existing].slice(0, SWARM_CLAIM_JOURNAL_LIMIT);
}

export function swarmClaimSettingsService(
  _db: Db,
  ports: SwarmClaimSettingsPorts,
): SwarmClaimSettingsService {
  const env = ports.env ?? process.env;

  async function readGeneral(): Promise<GeneralRecord> {
    return asGeneral(await ports.settings.getGeneral());
  }

  async function read(): Promise<ResolvedSwarmClaimSettings> {
    const general = await readGeneral();
    return resolveSwarmClaimSettings({ stored: general[SWARM_CLAIM_SETTINGS_KEY], env });
  }

  return {
    read,
    journal: async () => {
      const general = await readGeneral();
      return readJournal(general[SWARM_CLAIM_JOURNAL_KEY]);
    },
    async update(patch, actor) {
      const general = await readGeneral();
      const current = resolveSwarmClaimSettings({
        stored: general[SWARM_CLAIM_SETTINGS_KEY],
        env,
      });
      const next = mergeSwarmClaimSettings(current.settings, patch);
      const entry: SwarmClaimJournalEntry = {
        at: new Date().toISOString(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        patch,
      };
      // The journal lives under its own general key, so one atomic
      // updateGeneral write carries both the new settings and the entry —
      // they cannot disagree.
      await ports.settings.updateGeneral({
        [SWARM_CLAIM_SETTINGS_KEY]: next,
        [SWARM_CLAIM_JOURNAL_KEY]: appendJournal(
          readJournal(general[SWARM_CLAIM_JOURNAL_KEY]),
          entry,
        ),
      });
      await ports.logActivity?.({
        companyId: "",
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: SWARM_CLAIM_SETTINGS_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: SWARM_CLAIM_SETTINGS_KEY,
        details: { settings: next, patch },
      });
      return resolveSwarmClaimSettings({ stored: next, env });
    },
  };
}
