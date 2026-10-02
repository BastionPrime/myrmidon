// myrmidon(R5-B) bot image canary: the routes over the real service with fake
// ports, the same harness pattern the deploy-jobs routes use.
//
// Pins: reads need board access; writes need instance admin; an agent token is
// refused everywhere; a malformed reference is a 400; the disabled feature is a
// 503 on create, not on read.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { botCanaryRoutes } from "./canary-routes.js";
import { botCanaryService, type BotCanaryServiceDeps } from "./canary-service.js";
import { readBotCanarySettings } from "./canary-settings.js";
import { emptyBotCanaryDocument, type BotCanaryDocument } from "./canary-domain.js";
import type { BotCanaryRuntimePort } from "./canary-service.js";
import type { ApplyBotContainerOutcome } from "./index.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CANARY = "agent-canary";
const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CI_LABELS = {
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": "https://github.com/itkadr-git/myrmidon",
  "org.opencontainers.image.version": "main",
};

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function harness(options: { enabled?: boolean } = {}) {
  const doc: BotCanaryDocument = emptyBotCanaryDocument();
  const runtime: BotCanaryRuntimePort = {
    listAgents: vi.fn(async () => []),
    applyNow: vi.fn(async (): Promise<ApplyBotContainerOutcome> => ({ kind: "error" as const, message: "never" })),
    status: vi.fn(async () => ({ state: "missing" })),
    canaryApiKey: vi.fn(async () => null),
  };
  const deps: BotCanaryServiceDeps = {
    runtime,
    now: () => new Date("2026-09-30T08:00:00.000Z"),
    settings: {
      ...readBotCanarySettings({}),
      enabled: options.enabled ?? true,
      canaryBotKey: CANARY,
    },
    probes: {
      fetchJson: async (url: string) => {
        if (url.startsWith("https://ghcr.io/token")) return { token: "t" };
        if (url.includes("/manifests/")) return { config: { digest: "sha256:cfg" } };
        if (url.includes("/blobs/")) return { config: { Labels: CI_LABELS } };
        if (url.includes("/compare/")) return { status: "ahead" };
        return [];
      },
    },
    logActivity: (async () => ({})) as unknown as BotCanaryServiceDeps["logActivity"],
    smoke: vi.fn(async () => ({ ok: true as const, runId: "r", status: "completed" })) as unknown as BotCanaryServiceDeps["smoke"],
    env: {},
  };
  const service = botCanaryService(
    {
      read: async () => structuredClone(doc),
      mutate: async (change: (current: BotCanaryDocument) => { next: BotCanaryDocument | null; result: unknown }) => {
        const { next, result } = change(doc);
        if (next) Object.assign(doc, next);
        return { doc, result, changed: next !== null };
      },
    } as unknown as Db,
    deps,
  );
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = req.headers["x-test-actor"] === "admin" ? admin : req.headers["x-test-actor"] === "agent" ? agentActor : member;
    next();
  });
  app.use(express.json());
  app.use("/", botCanaryRoutes({} as Db, service));
  app.use(errorHandler);
  return { app, service };
}

describe("bot canary routes", () => {
  it("GET is readable by any board member", async () => {
    const { app } = harness();
    const res = await request(app).get("/myrmidon/bot-canary").expect(200);
    expect(res.body).toEqual({ job: null, history: [] });
  });

  it("GET is refused for an agent token", async () => {
    const { app } = harness();
    await request(app).get("/myrmidon/bot-canary").set("x-test-actor", "agent").expect(403);
  });

  it("preview is readable by a board member and answers the CI verdict", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/myrmidon/bot-canary/preview")
      .set("x-test-actor", "member")
      .send({ reference: GOOD })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.digest).toBe(GOOD);
  });

  it("preview refuses a malformed reference with 400", async () => {
    const { app } = harness();
    await request(app).post("/myrmidon/bot-canary/preview").set("x-test-actor", "member").send({ reference: "latest" }).expect(400);
  });

  it("create is instance-admin only: a plain member gets 403", async () => {
    const { app } = harness();
    await request(app).post("/myrmidon/bot-canary").set("x-test-actor", "member").send({ reference: GOOD }).expect(403);
  });

  it("create with an admin starts the rollout (201, verified image)", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/myrmidon/bot-canary")
      .set("x-test-actor", "admin")
      .send({ reference: GOOD, reason: "test rollout" })
      .expect(201);
    expect(res.body.status).toBe("canary_waiting");
    expect(res.body.canaryBotKey).toBe(CANARY);
    expect(res.body.digest).toBe(GOOD);
  });

  it("create is a 503 when the feature is disabled (read still works)", async () => {
    const { app } = harness({ enabled: false });
    await request(app).get("/myrmidon/bot-canary").expect(200);
    await request(app).post("/myrmidon/bot-canary").set("x-test-actor", "admin").send({ reference: GOOD }).expect(503);
  });

  it("abort is instance-admin only and answers 404 for an unknown rollout", async () => {
    const { app } = harness();
    await request(app)
      .post("/myrmidon/bot-canary/11111111-2222-4333-8444-555555555555/abort")
      .set("x-test-actor", "member")
      .send({ id: "11111111-2222-4333-8444-555555555555" })
      .expect(403);
    await request(app)
      .post("/myrmidon/bot-canary/11111111-2222-4333-8444-555555555555/abort")
      .set("x-test-actor", "admin")
      .send({ id: "11111111-2222-4333-8444-555555555555" })
      .expect(404);
  });

  it("a malformed reference on create is a 400", async () => {
    const { app } = harness();
    await request(app).post("/myrmidon/bot-canary").set("x-test-actor", "admin").send({ reference: "sha256:short" }).expect(400);
  });
});
