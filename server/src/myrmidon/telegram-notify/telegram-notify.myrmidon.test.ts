// myrmidon(OPE-3789): the telegram-notify core test — store company scoping,
// service merge and changelog rules, route authorization and HTTP shapes.
// Neutral English only (agent-a, example.com).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { emptyTelegramNotifyDocument } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { telegramNotifyRoutes } from "./routes.js";
import { applyTelegramNotifyPatch, telegramNotifyService } from "./service.js";
import { memoryTelegramNotifyStore } from "./store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
  companyIds: [COMPANY_ID],
};

const URL = "/api/myrmidon/telegram-notify";

function appWith(actor: unknown, store = memoryTelegramNotifyStore()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", telegramNotifyRoutes({ store, now: () => new Date("2026-10-03T12:00:00.000Z") }));
  app.use(errorHandler);
  return app;
}

describe("myrmidon(OPE-3789): the settings service merge and changelog", () => {
  it("applies a partial patch and keeps untouched fields", () => {
    const next = applyTelegramNotifyPatch(emptyTelegramNotifyDocument(), {
      digest: { enabled: true, chatId: "chat-1" },
      errors: { maxPerHour: 5 },
    });
    expect(next.settings.digest.enabled).toBe(true);
    expect(next.settings.digest.chatId).toBe("chat-1");
    expect(next.settings.digest.time).toBe("09:00");
    expect(next.settings.errors.maxPerHour).toBe(5);
    expect(next.settings.errors.enabled).toBe(false);
    expect(next.settings.inbound).toEqual({ enabled: false, requireMention: true });
  });

  it("writes one changelog entry per changed field, newest first", () => {
    const next = applyTelegramNotifyPatch(emptyTelegramNotifyDocument(), {
      digest: { enabled: true },
      errors: { maxPerHour: 5 },
    });
    expect(next.changelog.map((entry) => entry.field)).toEqual(["digest.enabled", "errors.maxPerHour"]);
    expect(next.changelog[0]).toMatchObject({ field: "digest.enabled", from: false, to: true });
    expect(next.changelog[1]).toMatchObject({ field: "errors.maxPerHour", from: 10, to: 5 });
  });

  it("does not record a field whose value did not change", () => {
    const next = applyTelegramNotifyPatch(emptyTelegramNotifyDocument(), {
      digest: { enabled: false, time: "09:00" },
      errors: { maxPerHour: 5 },
    });
    expect(next.changelog.map((entry) => entry.field)).toEqual(["errors.maxPerHour"]);
  });

  it("caps the changelog at the documented limit", () => {
    let document = emptyTelegramNotifyDocument();
    for (let i = 0; i < 205; i += 1) {
      document = applyTelegramNotifyPatch(document, { errors: { maxPerHour: i + 1 } });
    }
    expect(document.changelog).toHaveLength(200);
    expect(document.changelog[0]).toMatchObject({ field: "errors.maxPerHour", from: 204, to: 205 });
  });

  it("returns the current document untouched for an all-equal patch", async () => {
    const service = telegramNotifyService({ store: memoryTelegramNotifyStore() });
    const result = await service.update(COMPANY_ID, "user-a", { digest: { enabled: false } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changelog).toEqual([]);
      expect(result.value.settings.digest.enabled).toBe(false);
    }
  });
});

describe("myrmidon(OPE-3789): the store is company-scoped", () => {
  it("keeps two companies' documents apart", async () => {
    const service = telegramNotifyService({ store: memoryTelegramNotifyStore() });
    await service.update(COMPANY_ID, "user-a", { digest: { enabled: true, chatId: "chat-1" } });
    const other = await service.snapshot(OTHER_COMPANY_ID);
    expect(other.settings.digest.enabled).toBe(false);
    expect(other.settings.digest.chatId).toBeNull();
    const own = await service.snapshot(COMPANY_ID);
    expect(own.settings.digest.enabled).toBe(true);
  });
});

describe("myrmidon(OPE-3789): the routes", () => {
  it("GET answers the full contract with all fields present and everything off", async () => {
    const res = await request(appWith(member)).get(URL).expect(200);
    expect(res.body).toEqual({
      settings: {
        digest: {
          enabled: false,
          time: "09:00",
          chatId: null,
          topicId: null,
          sections: ["done", "blocked", "needs_decision", "spend"],
        },
        errors: { enabled: false, chatId: null, topicId: null, minSeverity: "error", maxPerHour: 10 },
        inbound: { enabled: false, requireMention: true },
        escalations: { enabled: false, hours: 24, channel: "none", chatId: null, topicId: null },
        proactivity: { mode: "only_on_owner_request", rarelyMaxPerDay: 3 },
      },
      changelog: [],
    });
  });

  it("PATCH applies a partial update and answers the new snapshot", async () => {
    const app = appWith(member);
    const res = await request(app)
      .patch(URL)
      .send({ digest: { enabled: true, chatId: "chat-1", time: "18:30" }, proactivity: { mode: "rarely" } })
      .expect(200);
    expect(res.body.settings.digest).toMatchObject({ enabled: true, chatId: "chat-1", time: "18:30" });
    expect(res.body.settings.proactivity.mode).toBe("rarely");
    expect(res.body.changelog).toHaveLength(4);
    expect(res.body.changelog[0]).toMatchObject({
      at: "2026-10-03T12:00:00.000Z",
      actor: "user-a",
      field: "digest.enabled",
      from: false,
      to: true,
    });
    // The change survives a fresh GET.
    const read = await request(app).get(URL).expect(200);
    expect(read.body.settings.digest.enabled).toBe(true);
    expect(read.body.changelog).toHaveLength(4);
  });

  it("PATCH with an equal value answers 200 and writes no changelog entry", async () => {
    const app = appWith(member);
    await request(app).patch(URL).send({ digest: { enabled: true } }).expect(200);
    const res = await request(app).patch(URL).send({ digest: { enabled: true } }).expect(200);
    expect(res.body.changelog).toHaveLength(1);
  });

  it("PATCH is board only: an agent actor is refused", async () => {
    const app = appWith(agentActor);
    await request(app).get(URL).expect(200);
    await request(app).patch(URL).send({ digest: { enabled: true } }).expect(403);
  });

  it("company access is enforced: a board member of another company is refused", async () => {
    const outsider = { ...member, userId: "user-c", companyIds: [OTHER_COMPANY_ID] };
    await request(appWith(outsider)).get(`${URL}?companyId=${COMPANY_ID}`).expect(403);
    const agentOfOther = { ...agentActor, companyId: OTHER_COMPANY_ID, companyIds: [OTHER_COMPANY_ID] };
    await request(appWith(agentOfOther)).get(`${URL}?companyId=${COMPANY_ID}`).expect(403);
  });

  it("the companyId query parameter selects the company", async () => {
    const store = memoryTelegramNotifyStore();
    const service = telegramNotifyService({ store });
    await service.update(OTHER_COMPANY_ID, "user-a", { digest: { enabled: true } });
    // A member of the other company reads its own slice through the parameter.
    const otherMember = { ...member, userId: "user-b", companyIds: [OTHER_COMPANY_ID] };
    const read = await request(appWith(otherMember, store))
      .get(`${URL}?companyId=${OTHER_COMPANY_ID}`)
      .expect(200);
    expect(read.body.settings.digest.enabled).toBe(true);
  });

  it("an actor with zero companies and no query parameter gets 422", async () => {
    const actor = { ...member, userId: "user-d", companyIds: [] };
    const res = await request(appWith(actor)).get(URL).expect(422);
    expect(res.body).toBeTruthy();
  });

  it("an invalid PATCH body is refused with 400 and writes nothing", async () => {
    const app = appWith(member);
    await request(app).patch(URL).send({ digest: { time: "25:00" } }).expect(400);
    await request(app).patch(URL).send({ digest: { colour: "red" } }).expect(400);
    await request(app).patch(URL).send({}).expect(400);
    const read = await request(app).get(URL).expect(200);
    expect(read.body.changelog).toEqual([]);
  });
});
