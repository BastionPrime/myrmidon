// server/src/myrmidon/castes/castes-api.myrmidon.test.ts
//
// myrmidon(1.6.1 CUSTOM-CASTES A): the REST API — access rules and request
// parsing. Plain fakes for the service: no database, no network. The
// service's own suite (castes.db.myrmidon.test.ts) covers the store against
// a real database.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { casteRoutes } from "./routes.js";
import type { CasteService } from "./service.js";
import type { CasteView } from "@paperclipai/shared";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [OTHER_COMPANY] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY_ID, keyId: "key-a" };

const casteView = (key: string): CasteView => ({
  key,
  nameEn: "Engineer",
  nameRu: "Инженер",
  description: null,
  color: "blue",
  icon: null,
  defaultModel: null,
  swarmEligible: true,
  maxActiveTasks: null,
  builtIn: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** A fake service that records what the routes asked it to do. */
function fakeService() {
  const calls: Array<{ op: string; companyId: string; key?: string; body?: unknown }> = [];
  const service: CasteService = {
    async listCastes(companyId) {
      calls.push({ op: "list", companyId });
      return [casteView("engineer")];
    },
    async createCaste(input) {
      calls.push({ op: "create", companyId: input.companyId, body: input.body });
      await input.activity?.({
        companyId: input.companyId,
        action: "caste_created",
        casteKey: input.body.key,
        details: {},
      });
      return casteView(input.body.key);
    },
    async updateCaste(input) {
      calls.push({ op: "update", companyId: input.companyId, key: input.key, body: input.body });
      return casteView(input.key);
    },
    async removeCaste(input) {
      calls.push({ op: "remove", companyId: input.companyId, key: input.key, body: input.reassignTo });
      await input.activity?.({
        companyId: input.companyId,
        action: "caste_removed",
        casteKey: input.key,
        details: {},
      });
    },
  };
  return { service, calls };
}

function app(actor: unknown) {
  const fake = fakeService();
  const activity: Array<{ action: string; casteKey: string }> = [];
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    casteRoutes({
      service: fake.service,
      recordActivity: async (entry) => {
        activity.push({ action: entry.action, casteKey: entry.casteKey });
      },
    }),
  );
  server.use(errorHandler);
  return { server, calls: fake.calls, activity };
}

const base = `/api/myrmidon/companies/${COMPANY_ID}/castes`;

describe("myrmidon(1.6.1 CUSTOM-CASTES) routes: access", () => {
  it("denies another company on every route (403, no service call)", async () => {
    const { server, calls } = app(outsider);
    await request(server).get(base).expect(403);
    await request(server).post(base).send({ key: "x", nameEn: "X" }).expect(403);
    await request(server).patch(`${base}/engineer`).send({ nameEn: "Y" }).expect(403);
    await request(server).delete(`${base}/engineer`).expect(403);
    expect(calls).toHaveLength(0);
  });

  it("lets an agent of the company read castes but not mutate", async () => {
    const { server, calls } = app(agentActor);
    await request(server).get(base).expect(200);
    await request(server).post(base).send({ key: "x", nameEn: "X" }).expect(403);
    await request(server).patch(`${base}/engineer`).send({ nameEn: "Y" }).expect(403);
    await request(server).delete(`${base}/engineer`).expect(403);
    expect(calls.map((c) => c.op)).toEqual(["list"]);
  });

  it("lets a board member of the company do everything", async () => {
    const { server } = app(member);
    const list = await request(server).get(base).expect(200);
    expect(list.body.castes).toHaveLength(1);
    await request(server).post(base).send({ key: "ops", nameEn: "Ops" }).expect(201);
    await request(server).patch(`${base}/engineer`).send({ nameEn: "Eng" }).expect(200);
    await request(server).delete(`${base}/engineer`).expect(204);
  });

  it("writes activity entries for mutations", async () => {
    const { server, activity } = app(member);
    await request(server).post(base).send({ key: "ops", nameEn: "Ops" }).expect(201);
    await request(server).delete(`${base}/engineer`).send({ reassignTo: "ops" }).expect(204);
    expect(activity.map((a) => a.action)).toEqual(["caste_created", "caste_removed"]);
  });
});

describe("myrmidon(1.6.1 CUSTOM-CASTES) routes: parsing", () => {
  it("rejects an invalid caste key on POST (400)", async () => {
    const { server, calls } = app(member);
    await request(server).post(base).send({ key: "Bad Key!", nameEn: "X" }).expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing nameEn on POST (400)", async () => {
    const { server } = app(member);
    await request(server).post(base).send({ key: "ops" }).expect(400);
  });

  it("rejects an invalid color on POST (400)", async () => {
    const { server } = app(member);
    await request(server).post(base).send({ key: "ops", nameEn: "Ops", color: "#ff0000" }).expect(400);
  });

  it("passes the reassignTo body through on DELETE", async () => {
    const { server, calls } = app(member);
    await request(server).delete(`${base}/engineer`).send({ reassignTo: "ops" }).expect(204);
    expect(calls[0]).toMatchObject({ op: "remove", key: "engineer", body: "ops" });
  });

  it("rejects an invalid reassignTo on DELETE (400)", async () => {
    const { server, calls } = app(member);
    await request(server).delete(`${base}/engineer`).send({ reassignTo: "Nope!" }).expect(400);
    expect(calls).toHaveLength(0);
  });
});
