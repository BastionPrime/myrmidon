// myrmidon(BROWSER-CONSOLE): route tests — plain fakes, no database.
// Covers the authorization contract (401 unauthenticated, 403 agent and
// non-owner, owner passes), the registry list, the screen lifecycle over
// HTTP, the journal shape and the domain validation of the data clear.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { browserConsoleRoutes } from "./routes.js";
import type { BrowserConsoleService } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const owner = {
  type: "board",
  source: "session",
  userId: "user-owner",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
};
const member = {
  type: "board",
  source: "session",
  userId: "user-member",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "member" }],
};
const agentActor = { type: "agent", source: "agent_key", agentId: "11111111-1111-4111-8111-111111111111", companyId: COMPANY_ID, keyId: "key-a" };
const anonymous = { type: "none" };

function serviceMock(overrides: Partial<BrowserConsoleService> = {}): BrowserConsoleService {
  const calls = { open: 0, done: 0, clear: 0 };
  const base = {
    fleet: vi.fn(() => []),
    timers: { idleTimeoutMs: 30 * 60_000, maxDurationMs: 120 * 60_000 },
    listBrowsers: vi.fn(async () => [
      { id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1" }, sessionActive: false, usedBy: null, sessionStartedAt: null },
    ]),
    openScreen: vi.fn(async () => {
      calls.open += 1;
      return {
        screenSessionId: "session-a",
        screenPath: "/api/myrmidon/browsers/browser-a/screen",
        deadlines: { idleDeadlineAt: 1, maxDeadlineAt: 2, autoCloseAt: 1, warnAt: 1 - 60_000 },
      };
    }),
    status: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({ deadlines: { idleDeadlineAt: 1, maxDeadlineAt: 2, autoCloseAt: 1, warnAt: 0 }, closedBy: null })),
    done: vi.fn(async () => {
      calls.done += 1;
    }),
    clearSiteData: vi.fn(async () => {
      calls.clear += 1;
    }),
    journal: vi.fn(async () => [
      { sessionId: "session-a", browserId: "browser-a", userId: "user-owner", openedAt: 0, endedAt: 5 * 60_000, durationMs: 5 * 60_000, closedBy: "done" as const },
    ]),
    assertBrowserScreenFreeForMcp: vi.fn(async () => {}),
  };
  return { ...base, ...overrides } as unknown as BrowserConsoleService & typeof base;
}

function app(actor: unknown, service: BrowserConsoleService) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", browserConsoleRoutes({ service }));
  server.use(errorHandler);
  return server;
}

const query = `?companyId=${COMPANY_ID}`;

describe("myrmidon(BROWSER-CONSOLE) routes: authorization", () => {
  it("unauthenticated requests get 401 on every route", async () => {
    const service = serviceMock();
    const server = app(anonymous, service);
    await request(server).get("/api/myrmidon/browsers").expect(401);
    await request(server).get("/api/myrmidon/browsers/journal").expect(401);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(401);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({}).expect(401);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/done${query}`).send({}).expect(401);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(401);
  });

  it("agents read the registry but never the screen, the data clear or the journal", async () => {
    const service = serviceMock();
    const server = app(agentActor, service);
    await request(server).get("/api/myrmidon/browsers").expect(200);
    await request(server).get("/api/myrmidon/browsers/journal").expect(403);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(403);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(403);
    expect(service.openScreen).not.toHaveBeenCalled();
  });

  it("a member (not owner) reads the registry but is refused the owner surface", async () => {
    const service = serviceMock();
    const server = app(member, service);
    await request(server).get("/api/myrmidon/browsers").expect(200);
    await request(server).get("/api/myrmidon/browsers/journal").expect(403);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(403);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(403);
  });

  it("the owner passes: open answers the deadline fields, done and journal work", async () => {
    const service = serviceMock();
    const server = app(owner, service);
    const list = await request(server).get("/api/myrmidon/browsers").expect(200);
    expect(list.body.browsers[0]).toMatchObject({ id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1" } });

    const opened = await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(200);
    expect(opened.body).toMatchObject({
      screenSessionId: "session-a",
      screenPath: "/api/myrmidon/browsers/browser-a/screen",
      idleDeadlineAt: new Date(1).toISOString(),
      warnAt: new Date(1 - 60_000).toISOString(),
    });

    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({ activity: true }).expect(200);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/done${query}`).send({}).expect(200);
    expect(service.done).toHaveBeenCalledWith("browser-a", "user-owner");

    const journal = await request(server).get(`/api/myrmidon/browsers/journal${query}`).expect(200);
    expect(journal.body.entries[0]).toMatchObject({
      browserId: "browser-a",
      userId: "user-owner",
      durationMs: 5 * 60_000,
      closedBy: "done",
    });
    expect(journal.body.entries[0].startedAt).toBeTypeOf("string");
    expect(journal.body.entries[0].endedAt).toBeTypeOf("string");
  });

  it("the data clear validates the domain: bare domains pass, URLs and junk do not", async () => {
    const service = serviceMock();
    const server = app(owner, service);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(200);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "https://example.com" }).expect(400);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com/path" }).expect(400);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "" }).expect(400);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "localhost" }).expect(400);
    expect(service.clearSiteData).toHaveBeenCalledTimes(1);
    expect(service.clearSiteData).toHaveBeenCalledWith("browser-a", "example.com");
  });

  it("heartbeat requires a boolean activity field", async () => {
    const service = serviceMock();
    const server = app(owner, service);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({ activity: "yes" }).expect(400);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({}).expect(200);
  });
});
