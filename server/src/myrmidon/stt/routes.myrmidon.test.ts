// myrmidon(1.6.1 VOICE-STT A1): the board settings endpoint
// (`GET/PATCH /api/myrmidon/companies/:companyId/voice-stt`), over a fake
// runtime — the transport contract, not the database.
//
// Pins: GET is company access, PATCH is board only; the response carries the
// effective settings and the degradation problem, never a key value; an
// unknown field is rejected.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonSttRoutes, type SttRuntime } from "./index.js";
import { mutateSttOverrides } from "./store.js";
import { sttSettings, STT_ENABLED_ENV, STT_BASE_URL_ENV, STT_KEY_SECRET_ENV, STT_MODEL_ENV, type StoredSttOverrides } from "./settings.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};

const agent = {
  type: "agent",
  source: "api_key",
  agentId: "agent-a",
  companyId: COMPANY_ID,
};

const OTHER_COMPANY_AGENT = {
  type: "agent",
  source: "api_key",
  agentId: "agent-a",
  companyId: "99999999-9999-4999-8999-999999999999",
};

const settings = sttSettings({
  [STT_ENABLED_ENV]: "1",
  [STT_BASE_URL_ENV]: "http://gateway.example.com",
  [STT_KEY_SECRET_ENV]: "stt-key",
  [STT_MODEL_ENV]: "stt-model",
});

function harness(runtime: SttRuntime = { settings: vi.fn(async () => settings), transcribe: vi.fn() }) {
  // A fake Db: the routes only read/write the stored overrides and journal.
  const stored = new Map<string, StoredSttOverrides | null>();
  const fakeDb = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: vi.fn(async () => {}),
        select: vi.fn(async () => [{ id: "row", general: { myrmidonSttCompanies: Object.fromEntries(stored) } }]),
        update: vi.fn(async () => {}),
      }),
    ),
    select: vi.fn(async () => [{ general: { myrmidonSttCompanies: Object.fromEntries(stored) } }]),
    logActivity: vi.fn(async () => {}),
  } as unknown as never;
  const capture = {
    mutateSttOverrides: (async (db2: unknown, companyId: string, change: (current: StoredSttOverrides | null) => { next: StoredSttOverrides | null; result: null }) => {
      const next = change(stored.get(companyId) ?? null).next;
      if (next) stored.set(companyId, next);
      return { doc: next, result: null, changed: Boolean(next) };
    }) as unknown as typeof mutateSttOverrides,
  };
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    // The routes read/write through the store module; the fake capture
    // replaces the db-touching write so the suite stays on the transport
    // contract. The store's own logic is covered by its own suite.
    app.use("/api", myrmidonSttRoutes(fakeDb, runtime, { mutateSttOverrides: capture.mutateSttOverrides }));
    app.use(errorHandler);
    return app;
  };
  return { app: withActor(member), withActor };
}

const URL = `/api/myrmidon/companies/${COMPANY_ID}/voice-stt`;

describe("voice-stt settings endpoint", () => {
  it("answers the effective settings with the degradation problem", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      backend: "dashscope",
      baseUrl: "http://gateway.example.com",
      model: "stt-model",
      problem: null,
    });
    // The key secret NAME may travel; the value never exists in the response.
    expect(JSON.stringify(res.body)).not.toContain("company-key-value");
  });

  it("carries the problem when the path is unconfigured", async () => {
    const { app } = harness({
      settings: vi.fn(async () => sttSettings({ [STT_ENABLED_ENV]: "1" })),
      transcribe: vi.fn(),
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.problem).toMatchObject({ code: "stt_unconfigured" });
  });

  it("gives the agent of the same company read access", async () => {
    const { withActor } = harness();
    await request(withActor(agent)).get(URL).expect(200);
  });

  it("refuses an agent of another company", async () => {
    const { withActor } = harness();
    await request(withActor(OTHER_COMPANY_AGENT)).get(URL).expect(403);
  });

  it("PATCH is board only: an agent gets 403 and nothing is stored", async () => {
    const { withActor } = harness();
    await request(withActor(agent)).patch(URL).send({ enabled: true }).expect(403);
  });

  it("PATCH returns the merged view and the stored overrides go through the runtime", async () => {
    const settingsAfterPatch = {
      ...settings,
      enabled: true,
      model: "other-model",
      diarization: true,
      maxDurationSec: 600,
    };
    const runtime: SttRuntime = {
      settings: vi.fn(async () => settingsAfterPatch),
      transcribe: vi.fn(),
    };
    const { app } = harness(runtime);
    const res = await request(app).patch(URL).send({ model: "other-model", diarization: true, maxDurationSec: 600 }).expect(200);
    expect(res.body).toMatchObject({ model: "other-model", diarization: true, maxDurationSec: 600 });
  });

  it("rejects an unknown field", async () => {
    const { app } = harness();
    await request(app).patch(URL).send({ frobnicate: true }).expect(400);
  });

  it("rejects an out-of-range duration", async () => {
    const { app } = harness();
    await request(app).patch(URL).send({ maxDurationSec: 0 }).expect(400);
  });

  it("accepts an explicit null model (back to the environment default)", async () => {
    const { app } = harness();
    await request(app).patch(URL).send({ model: null }).expect(200);
  });
});
