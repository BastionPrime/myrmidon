// myrmidon(1.6-WIKI): the regulation API — access rules, draft writes, approval, rollback.
//
// Plain fakes for the store: no database, no network.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { wikiRegulationRoutes, type WikiRegulationActivityEntry } from "./routes.js";
import { createWikiRegulationService, type RegulationStore } from "./service.js";
import type { RegulationPageRecord } from "./types.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: ["other-company"] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY_ID, keyId: "key-a" };

function memoryStore(): RegulationStore {
  const rows = new Map<string, RegulationPageRecord>();
  const key = (companyId: string, slug: string) => `${companyId}::${slug}`;
  return {
    async list(companyId) {
      return [...rows.values()].filter((row) => row.companyId === companyId);
    },
    async get(companyId, slug) {
      return rows.get(key(companyId, slug)) ?? null;
    },
    async put(page) {
      rows.set(key(page.companyId, page.slug), structuredClone(page));
      return structuredClone(page);
    },
  };
}

function app(actor: unknown, onActivity?: (entry: WikiRegulationActivityEntry) => void) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    wikiRegulationRoutes({
      service: createWikiRegulationService(memoryStore(), { newId: () => "page-1", now: () => new Date("2026-01-01T00:00:00.000Z") }),
      recordActivity: async (entry) => {
        onActivity?.(entry);
      },
    }),
  );
  server.use(errorHandler);
  return server;
}

const base = `/api/myrmidon/companies/${COMPANY_ID}/wiki-regulations`;

describe("myrmidon(1.6-WIKI) regulation routes: access", () => {
  it("answers 404 for another company", async () => {
    await request(app(outsider)).get(base).expect(404);
    await request(app(outsider)).put(`${base}/deploy/oncall`).send({ title: "t", content: "c" }).expect(404);
  });

  it("lets an agent of the company write a draft but not approve or roll back", async () => {
    const server = app(agentActor);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v1" }).expect(200);
    await request(server).post(`${base}/deploy/oncall/approve`).expect(403);
    await request(server).post(`${base}/deploy/oncall/rollback`).send({ revisionNumber: 1 }).expect(403);
  });

  it("lets a board member of the company do both", async () => {
    const server = app(member);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v1" }).expect(200);
    await request(server).post(`${base}/deploy/oncall/approve`).expect(200);
  });
});

describe("myrmidon(1.6-WIKI) regulation routes: lifecycle", () => {
  it("carries a draft through approval into the resolver", async () => {
    const server = app(member);
    const created = await request(server)
      .put(`${base}/deploy/oncall`)
      .send({ title: "On-call rotation", roles: ["engineer"], content: "v1 text" })
      .expect(200);
    expect(created.body.status).toBe("draft");
    expect(created.body.slug).toBe("deploy/oncall");
    expect(created.body.revisionNumber).toBe(1);

    expect((await request(server).get(`${base}/approved/engineer`).expect(200)).body.regulations).toEqual([]);

    await request(server).post(`${base}/deploy/oncall/approve`).expect(200);
    const resolved = await request(server).get(`${base}/approved/engineer`).expect(200);
    expect(resolved.body.role).toBe("engineer");
    expect(resolved.body.regulations).toHaveLength(1);
    expect(resolved.body.regulations[0].content).toBe("v1 text");
    expect(resolved.body.regulations[0].pageId).toBe("page-1");

    // A second edit is a draft again and waits for the next approval.
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v2 text" }).expect(200);
    const stillV1 = await request(server).get(`${base}/approved/engineer`).expect(200);
    expect(stillV1.body.regulations[0].content).toBe("v1 text");

    await request(server).post(`${base}/deploy/oncall/approve`).expect(200);
    const v2 = await request(server).get(`${base}/approved/engineer`).expect(200);
    expect(v2.body.regulations[0].content).toBe("v2 text");
    expect(v2.body.regulations[0].version).toBe(2);
  });

  it("rolls a page back to an earlier revision", async () => {
    const server = app(member);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v1 text" }).expect(200);
    await request(server).post(`${base}/deploy/oncall/approve`).expect(200);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v2 text" }).expect(200);
    await request(server).post(`${base}/deploy/oncall/approve`).expect(200);

    const rolledBack = await request(server).post(`${base}/deploy/oncall/rollback`).send({ revisionNumber: 1 }).expect(200);
    expect(rolledBack.body.content).toBe("v1 text");
    expect(rolledBack.body.revisionNumber).toBe(3);

    const resolved = await request(server).get(`${base}/approved/engineer`).expect(200);
    expect(resolved.body.regulations[0].content).toBe("v1 text");
  });

  it("lists the pages of the company and reads one by slug", async () => {
    const server = app(member);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v1" }).expect(200);
    await request(server).put(`${base}/brand/voice`).send({ title: "Brand voice", roles: ["*"], content: "v1" }).expect(200);

    const list = await request(server).get(base).expect(200);
    expect(list.body.regulations.map((page: { slug: string }) => page.slug).sort()).toEqual(["brand/voice", "deploy/oncall"]);

    const one = await request(server).get(`${base}/brand/voice`).expect(200);
    expect(one.body.title).toBe("Brand voice");
    expect(one.body.revisions).toHaveLength(1);

    await request(server).get(`${base}/no/such/page`).expect(404);
  });

  it("records the mutation in the activity log", async () => {
    const seen: WikiRegulationActivityEntry[] = [];
    const server = app(member, (entry) => seen.push(entry));
    await request(server).put(`${base}/deploy/oncall`).send({ title: "On-call rotation", roles: ["engineer"], content: "v1" }).expect(200);
    await request(server).post(`${base}/deploy/oncall/approve`).expect(200);

    expect(seen.map((entry) => entry.action)).toEqual(["wiki.regulation_draft_saved", "wiki.regulation_approved"]);
    expect(seen[0]!.companyId).toBe(COMPANY_ID);
    expect(seen[1]!.actor).toEqual({ agentId: null, userId: "user-a" });
  });

  it("validates the request body", async () => {
    const server = app(member);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "t" }).expect(400);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "t", content: "c", roles: "engineer" }).expect(400);
    await request(server).put(`${base}/deploy/oncall`).send({ title: "t", content: "c" }).expect(200);
    await request(server).post(`${base}/deploy/oncall/rollback`).send({}).expect(400);
  });
});

describe("myrmidon(1.6-WIKI) regulation routes: no database imports", () => {
  it("keeps the module free of the db package", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("./routes.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@paperclipai/db");
  });
});