// server/src/myrmidon/swarm-claim/settings.myrmidon.test.ts
//
// myrmidon(1.6.1 SWARM-SETTINGS-UI): the settings service — read, update and
// the change journal. The service is the database half of "включение задаются
// в интерфейсе": every update writes the instance settings row the server
// re-reads on each claim, and appends a journal entry the settings screen
// renders as "who turned this on, and when".

import { describe, expect, it, vi } from "vitest";
import { SWARM_CLAIM_SETTINGS_KEY } from "@paperclipai/shared";
import {
  SWARM_CLAIM_JOURNAL_KEY,
  SWARM_CLAIM_SETTINGS_UPDATED_ACTION,
  swarmClaimSettingsService,
  type SwarmClaimJournalEntry,
} from "./settings.js";

interface FakeGeneralStore {
  general: Record<string, unknown>;
  updates: Array<Record<string, unknown>>;
}

function fakePorts(start: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const store: FakeGeneralStore = { general: { ...start }, updates: [] };
  const logActivity = vi.fn();
  const service = swarmClaimSettingsService(null as never, {
    settings: {
      getGeneral: async () => store.general,
      updateGeneral: async (patch: Record<string, unknown>) => {
        store.updates.push(patch);
        store.general = { ...store.general, ...patch };
        return store.general;
      },
    },
    logActivity,
    env,
  });
  return { service, store, logActivity };
}

describe("myrmidon(1.6.1 SWARM-SETTINGS-UI) settings service", () => {
  it("reads the resolved settings and the source map from the row", async () => {
    const { service } = fakePorts({
      [SWARM_CLAIM_SETTINGS_KEY]: {
        enabled: true,
        enabledRoles: ["engineer"],
        enabledCompanyIds: [],
        leaseTtlSec: 900,
        maxActiveTasks: 3,
        sweepIntervalSec: 30,
        p0Preemption: true,
      },
    });
    const resolved = await service.read();
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.settings.enabledRoles).toEqual(["engineer"]);
    expect(resolved.sources.enabled).toBe("settings");
  });

  it("an update merges the patch, writes the row and appends the journal entry", async () => {
    const { service, store, logActivity } = fakePorts();
    const resolved = await service.update(
      { enabled: true, enabledRoles: ["engineer"], leaseTtlSec: 600 },
      { actorType: "user", actorId: "user-7" },
    );
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.settings.leaseTtlSec).toBe(600);
    expect(resolved.sources.enabled).toBe("settings");

    // One write carried both the settings and the journal entry.
    expect(store.updates).toHaveLength(1);
    const written = store.updates[0]!;
    expect(written[SWARM_CLAIM_SETTINGS_KEY]).toMatchObject({ enabled: true, leaseTtlSec: 600 });
    const journal = written[SWARM_CLAIM_JOURNAL_KEY] as SwarmClaimJournalEntry[];
    expect(journal).toHaveLength(1);
    expect(journal[0]!.actorType).toBe("user");
    expect(journal[0]!.actorId).toBe("user-7");
    expect(journal[0]!.patch).toMatchObject({ enabled: true, leaseTtlSec: 600 });
    expect(typeof journal[0]!.at).toBe("string");

    // The journal reads back newest-first.
    await service.update({ maxActiveTasks: 5 }, { actorType: "agent", actorId: "agent-2" });
    const readBack = await service.journal();
    expect(readBack).toHaveLength(2);
    expect(readBack[0]!.actorId).toBe("agent-2");
    expect(readBack[1]!.actorId).toBe("user-7");

    // The activity row is the audit trail of the same change.
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: SWARM_CLAIM_SETTINGS_UPDATED_ACTION }),
    );
  });

  it("a stored value survives because the env override is unset; a set env wins", async () => {
    const withEnv = fakePorts(
      {
        [SWARM_CLAIM_SETTINGS_KEY]: {
          enabled: true,
          enabledRoles: [],
          enabledCompanyIds: [],
          leaseTtlSec: 900,
          maxActiveTasks: 3,
          sweepIntervalSec: 30,
          p0Preemption: true,
        },
      },
      { MYRMIDON_SWARM_CLAIM_ENABLED: "0" },
    );
    const resolved = await withEnv.service.read();
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe("env");
  });

  it("the journal is empty when nothing was ever changed", async () => {
    const { service } = fakePorts();
    expect(await service.journal()).toEqual([]);
  });
});
