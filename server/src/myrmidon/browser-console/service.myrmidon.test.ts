// myrmidon(BROWSER-CONSOLE): service tests with fakes for time and the screen node.
// The red run for the guard test (idle timer closes the screen) lives in
// idle-timer.myrmidon.test.ts; this file covers the rest of the contract.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import type { ScreenConsoleClient } from "./screen-console-client.js";
import { browserConsoleService } from "./service.js";
import { autoCloseReason, readBrowserConsoleTimers, sessionDeadlines } from "./timers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FLEET_JSON = JSON.stringify([
  { id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1", ig: "socks nd1" } },
]);

type FakeCalls = { open: string[]; done: string[]; heartbeat: Array<{ screenSessionId: string; activity: boolean }>; pause: string[]; resume: string[]; clear: Array<{ browserId: string; domain: string }> };

function fakeScreenConsole(): { client: ScreenConsoleClient; calls: FakeCalls } {
  const calls: FakeCalls = { open: [], done: [], heartbeat: [], pause: [], resume: [], clear: [] };
  const screenSessionIds = new Map<string, string>();
  let counter = 0;
  return {
    calls,
    client: {
      async open(browserId) {
        calls.open.push(browserId);
        const id = `screen-${++counter}`;
        screenSessionIds.set(browserId, id);
        return { wsUrl: `ws://127.0.0.1:1/${id}`, screenSessionId: id };
      },
      async done(screenSessionId) {
        calls.done.push(screenSessionId);
      },
      async heartbeat(screenSessionId, activity) {
        calls.heartbeat.push({ screenSessionId, activity });
      },
      async pauseBots(browserId) {
        calls.pause.push(browserId);
      },
      async resumeBots(browserId) {
        calls.resume.push(browserId);
      },
      async clearSiteData(browserId, domain) {
        calls.clear.push({ browserId, domain });
      },
    },
  };
}

describeEmbeddedPostgres("browser console service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let clock: number;
  const at = (ms: number) => () => {
    clock = ms;
    return clock;
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-browser-console-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeService(env: Record<string, string> = {}) {
    const fake = fakeScreenConsole();
    const service = browserConsoleService({
      db,
      client: fake.client,
      env: { MYRMIDON_BROWSER_FLEET: FLEET_JSON, ...env } as NodeJS.ProcessEnv,
      now: () => clock,
    });
    return { service, fake };
  }

  it("lists the registry from env with live session occupancy", async () => {
    clock = 1_000_000;
    const { service } = await makeService();
    let list = await service.listBrowsers();
    expect(list).toEqual([{ id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1", ig: "socks nd1" }, sessionActive: false, usedBy: null, sessionStartedAt: null }]);

    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    list = await service.listBrowsers();
    expect(list[0]).toMatchObject({ sessionActive: true, usedBy: "user-a" });

    // An invalid registry reads as empty (warned), never throws.
    const brokenService = browserConsoleService({
      db,
      client: fakeScreenConsole().client,
      env: { MYRMIDON_BROWSER_FLEET: "{not json" } as NodeJS.ProcessEnv,
      now: () => clock,
      log: { warn: vi.fn(), error: vi.fn() },
    });
    expect(await brokenService.fleet()).toEqual([]);
  });

  it("opens and closes a session: pause on open, resume and journal on done", async () => {
    clock = 1_000_000;
    const { service, fake } = await makeService();
    const opened = await service.openScreen({ browserId: "browser-a", userId: "user-a" });

    expect(fake.calls.open).toEqual(["browser-a"]);
    expect(fake.calls.pause).toEqual(["browser-a"]);
    expect(opened.screenPath).toBe("/api/myrmidon/browsers/browser-a/screen");

    clock += 5 * 60_000;
    await service.done("browser-a", "user-a");
    expect(fake.calls.done).toHaveLength(1);
    expect(fake.calls.resume).toEqual(["browser-a"]);

    const journal = await service.journal();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      browserId: "browser-a",
      userId: "user-a",
      closedBy: "done",
      durationMs: 5 * 60_000,
    });
  });

  it("refuses a second session on the same browser and an unknown browser", async () => {
    clock = 1_000_000;
    const { service, fake } = await makeService();
    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    await expect(service.openScreen({ browserId: "browser-a", userId: "user-b" })).rejects.toMatchObject({ status: 409 });
    await expect(service.openScreen({ browserId: "browser-zz", userId: "user-a" })).rejects.toMatchObject({ status: 404 });
    expect(fake.calls.open).toEqual(["browser-a"]);
  });

  it("rolls the node session back when pauseBots fails", async () => {
    clock = 1_000_000;
    const fake = fakeScreenConsole();
    fake.client.pauseBots = async () => {
      throw new Error("node refused");
    };
    const service = browserConsoleService({
      db,
      client: fake.client,
      env: { MYRMIDON_BROWSER_FLEET: FLEET_JSON } as NodeJS.ProcessEnv,
      now: () => clock,
      log: { warn: vi.fn(), error: vi.fn() },
    });
    await expect(service.openScreen({ browserId: "browser-a", userId: "user-a" })).rejects.toMatchObject({ status: 502 });
    expect(fake.calls.done).toHaveLength(1);
    expect(await service.journal()).toEqual([]);
  });

  it("a heartbeat with activity pushes the idle deadline back; without activity it does not", async () => {
    clock = 1_000_000;
    const { service } = await makeService({ MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN: "10", MYRMIDON_BROWSER_MAX_DURATION_MIN: "120" });
    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    const before = await service.status("browser-a");
    expect(before!.deadlines.idleDeadlineAt).toBe(1_000_000 + 10 * 60_000);

    clock += 9 * 60_000;
    const beat = await service.heartbeat("browser-a", "user-a", true);
    expect(beat.deadlines.idleDeadlineAt).toBe(1_000_000 + 9 * 60_000 + 10 * 60_000);

    const idleBeat = await service.heartbeat("browser-a", "user-a", false);
    expect(idleBeat.deadlines.idleDeadlineAt).toBe(1_000_000 + 9 * 60_000 + 10 * 60_000);
  });

  it("the hard ceiling closes the session even with constant activity", async () => {
    clock = 1_000_000;
    const { service } = await makeService({ MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN: "5", MYRMIDON_BROWSER_MAX_DURATION_MIN: "30" });
    await service.openScreen({ browserId: "browser-a", userId: "user-a" });

    // Keep activity flowing past the ceiling.
    for (let minute = 1; minute <= 31; minute += 1) {
      clock = 1_000_000 + minute * 60_000;
      await service.heartbeat("browser-a", "user-a", true);
    }
    expect(await service.status("browser-a")).toBeNull();
    const journal = await service.journal();
    expect(journal[0]).toMatchObject({ closedBy: "max_duration" });
  });

  it("only the session owner may heartbeat or close; another owner gets 403", async () => {
    clock = 1_000_000;
    const { service } = await makeService();
    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    await expect(service.heartbeat("browser-a", "user-b", true)).rejects.toMatchObject({ status: 403 });
    await expect(service.done("browser-a", "user-b")).rejects.toMatchObject({ status: 403 });
    expect(await service.status("browser-a")).not.toBeNull();
  });

  it("clearSiteData goes to the node and refuses while a session is open", async () => {
    clock = 1_000_000;
    const { service, fake } = await makeService();
    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    await expect(service.clearSiteData("browser-a", "example.com")).rejects.toMatchObject({ status: 409 });

    await service.done("browser-a", "user-a");
    await service.clearSiteData("browser-a", "example.com");
    expect(fake.calls.clear).toEqual([{ browserId: "browser-a", domain: "example.com" }]);
    await expect(service.clearSiteData("browser-zz", "example.com")).rejects.toMatchObject({ status: 404 });
  });

  it("the server guard rejects MCP calls while the screen is open, and frees after close", async () => {
    clock = 1_000_000;
    const { service } = await makeService();
    await expect(service.assertBrowserScreenFreeForMcp("browser-a")).resolves.toBeUndefined();
    await service.openScreen({ browserId: "browser-a", userId: "user-a" });
    await expect(service.assertBrowserScreenFreeForMcp("browser-a")).rejects.toMatchObject({ status: 423, message: expect.stringContaining("MCP calls are paused") });
    await service.done("browser-a", "user-a");
    await expect(service.assertBrowserScreenFreeForMcp("browser-a")).resolves.toBeUndefined();
  });
});

describe("browser console timers (pure rules)", () => {
  const timers = { idleTimeoutMs: 30 * 60_000, maxDurationMs: 120 * 60_000 };

  it("computes the deadlines and the 60s warning window", () => {
    const deadlines = sessionDeadlines({ openedAt: 0, lastActivityAt: 0, timers });
    expect(deadlines).toEqual({ idleDeadlineAt: timers.idleTimeoutMs, maxDeadlineAt: timers.maxDurationMs, autoCloseAt: timers.idleTimeoutMs, warnAt: timers.idleTimeoutMs - 60_000 });
  });

  it("picks the nearer deadline and names the reason", () => {
    const idleWins = sessionDeadlines({ openedAt: 0, lastActivityAt: 0, timers });
    expect(autoCloseReason({ deadlines: idleWins, now: timers.idleTimeoutMs })).toBe("idle_timeout");
    const active = sessionDeadlines({ openedAt: 0, lastActivityAt: 110 * 60_000, timers });
    expect(autoCloseReason({ deadlines: active, now: 120 * 60_000 })).toBe("max_duration");
    expect(autoCloseReason({ deadlines: active, now: 119 * 60_000 })).toBeNull();
  });

  it("env parsing falls back on garbage and honors minutes", () => {
    expect(readBrowserConsoleTimers({})).toEqual(timers);
    expect(readBrowserConsoleTimers({ MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN: "abc" })).toEqual(timers);
    expect(readBrowserConsoleTimers({ MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN: "1", MYRMIDON_BROWSER_MAX_DURATION_MIN: "5" })).toEqual({ idleTimeoutMs: 60_000, maxDurationMs: 5 * 60_000 });
  });
});

