// myrmidon(BROWSER-CONSOLE): the idle-timer guard test (the PR's test-сторож).
//
// RED on the code without the fix: if the idle timer does not close the
// session, `status()` returns a live record and the journal stays empty, so
// both expects fail. Proven by the red run in the PR (service.ts reverted to
// a stub whose liveSession never expires).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import type { ScreenConsoleClient } from "./screen-console-client.js";
import { browserConsoleService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FLEET_JSON = JSON.stringify([{ id: "browser-a", displayName: "Live browser A", egress: {} }]);

function fakeClient(): ScreenConsoleClient {
  return {
    async open(browserId) {
      return { wsUrl: `ws://127.0.0.1:1/${browserId}`, screenSessionId: `screen-${browserId}` };
    },
    async done() {},
    async heartbeat() {},
    async pauseBots() {},
    async resumeBots() {},
    async clearSiteData() {},
  };
}

describeEmbeddedPostgres("browser console idle timer closes the screen", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let clock: number;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-browser-idle-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("closes the session when the idle deadline passes without activity", async () => {
    clock = 1_000_000;
    const service = browserConsoleService({
      db,
      client: fakeClient(),
      env: { MYRMIDON_BROWSER_FLEET: FLEET_JSON, MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN: "5" } as NodeJS.ProcessEnv,
      now: () => clock,
      log: { warn: vi.fn(), error: vi.fn() },
    });

    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    clock += 4 * 60_000;
    expect(await service.status("browser-a")).not.toBeNull();

    // Cross the idle deadline with NO activity: the next read must close it.
    clock += 2 * 60_000;
    expect(await service.status("browser-a")).toBeNull();

    const journal = await service.journal();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ browserId: "browser-a", userId: "user-a", closedBy: "idle_timeout" });
  });

  it("activity keeps the session alive past the original idle deadline", async () => {
    clock = 1_000_000;
    const service = browserConsoleService({
      db,
      client: fakeClient(),
      env: { MYRMIDON_BROWSER_FLEET: FLEET_JSON, MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN: "5", MYRMIDON_BROWSER_MAX_DURATION_MIN: "60" } as NodeJS.ProcessEnv,
      now: () => clock,
      log: { warn: vi.fn(), error: vi.fn() },
    });

    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    clock += 4 * 60_000;
    await service.heartbeat("browser-a", "user-a", true);
    clock += 4 * 60_000; // past the original deadline, refreshed by activity
    expect(await service.status("browser-a")).not.toBeNull();
  });
});
