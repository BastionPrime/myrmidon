// myrmidon(UI2-I18N) UI2-LANGUAGE: the per-user UI language preference routes.
//
// The routes run over fake ports (storage row, membership list, audit sink),
// so validation, permissions and the audit record are all exercised without a
// database — the runtime-limits harness pattern.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Ui2Language } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { ui2LanguageRoutes } from "./routes.js";
import { UI2_LANGUAGE_ACTION, type Ui2LanguageServiceDeps } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID_B = "33333333-3333-4333-8333-333333333333";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const boardWithoutUserId = {
  type: "board",
  source: "local_implicit",
  userId: null,
  isInstanceAdmin: true,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

interface HarnessOptions {
  stored?: Ui2Language | null;
  companyIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const current = { language: options.stored ?? null };
  const upserts: Array<{ userId: string; language: string }> = [];

  const deps: Ui2LanguageServiceDeps = {
    getLanguage: async () => current.language,
    upsertLanguage: async (userId, language) => {
      upserts.push({ userId, language });
      current.language = language;
      return { language, updatedAt: new Date("2026-10-02T00:00:00.000Z") };
    },
    listCompanyIdsForUser: async () => options.companyIds ?? [COMPANY_ID, COMPANY_ID_B],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", ui2LanguageRoutes({} as Db, deps));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, audits, upserts, deps };
}

const URL = "/api/myrmidon/ui2/language/me";

describe("myrmidon(UI2-I18N) ui2 language: reading the preference", () => {
  it("answers en for a user who never saved a preference", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body).toEqual({ language: "en", updatedAt: null });
  });

  it("answers the stored language once one exists", async () => {
    const { app } = harness({ stored: "ru" });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.language).toBe("ru");
  });
});

describe("myrmidon(UI2-I18N) ui2 language: access", () => {
  it("refuses agents on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).put(URL).send({ language: "ru" }).expect(403);
    expect(h.upserts).toEqual([]);
  });

  it("refuses a board actor without a user id", async () => {
    const h = harness();
    await request(h.withActor(boardWithoutUserId)).get(URL).expect(403);
    await request(h.withActor(boardWithoutUserId)).put(URL).send({ language: "ru" }).expect(403);
  });

  it("rejects an unknown language code with 400", async () => {
    const h = harness();
    await request(h.app).put(URL).send({ language: "fr" }).expect(400);
    expect(h.upserts).toEqual([]);
  });

  it("rejects a body without the language field with 400", async () => {
    const h = harness();
    await request(h.app).put(URL).send({}).expect(400);
    expect(h.upserts).toEqual([]);
  });
});

describe("myrmidon(UI2-I18N) ui2 language: writing the preference", () => {
  it("persists the choice and audits every company membership", async () => {
    const h = harness();
    const res = await request(h.app).put(URL).send({ language: "ru" }).expect(200);
    expect(res.body).toEqual({ language: "ru", updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(h.upserts).toEqual([{ userId: "user-a", language: "ru" }]);
    expect(h.audits).toHaveLength(2);
    expect(h.audits[0]).toMatchObject({
      companyId: COMPANY_ID,
      action: UI2_LANGUAGE_ACTION,
      details: { userId: "user-a", language: "ru", previous: null },
    });
    expect(h.audits[1]).toMatchObject({ companyId: COMPANY_ID_B });
  });

  it("records the previous language in the audit entry on a change", async () => {
    const h = harness({ stored: "en" });
    await request(h.app).put(URL).send({ language: "ru" }).expect(200);
    expect(h.audits[0]).toMatchObject({
      details: { userId: "user-a", language: "ru", previous: "en" },
    });
  });

  it("audits nothing when the user belongs to no company", async () => {
    const h = harness({ companyIds: [] });
    await request(h.app).put(URL).send({ language: "ru" }).expect(200);
    expect(h.upserts).toHaveLength(1);
    expect(h.audits).toEqual([]);
  });

  it("is idempotent on the read side after a write", async () => {
    const h = harness();
    await request(h.app).put(URL).send({ language: "ru" }).expect(200);
    const res = await request(h.app).get(URL).expect(200);
    expect(res.body.language).toBe("ru");
  });
});
