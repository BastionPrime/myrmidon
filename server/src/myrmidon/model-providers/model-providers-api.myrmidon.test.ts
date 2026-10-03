// server/src/myrmidon/model-providers/model-providers-api.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A): the settings API — access rules,
// request parsing, and that no response ever carries the key value.
//
// Plain fakes for the service: no database, no network. The service's own
// suite (model-providers.db.myrmidon.test.ts) covers the store against a
// real database.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { modelProviderRoutes } from "./routes.js";
import type { ModelProviderService, ModelProviderView } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";

const KEY_VALUE = "sk-test-provider-key-value-1234";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [OTHER_COMPANY] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY_ID, keyId: "key-a" };

const providerView = (id: string): ModelProviderView => ({
  id,
  type: "openai",
  name: "OpenAI main",
  baseUrl: "https://api.openai.com/v1",
  hasKey: true,
  credentialSecretName: `model-provider-key-${id}`,
  free: false,
  keyValidatedAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

/** A fake service that records what the routes asked it to do. */
function fakeService() {
  const calls: Array<{ op: string; companyId: string; providerId?: string; body?: unknown }> = [];
  const service: ModelProviderService = {
    async createProvider(input) {
      calls.push({ op: "create", companyId: input.companyId, body: input.body });
      await input.activity?.({
        companyId: input.companyId,
        action: "model_provider_added",
        providerId: "provider-1",
        details: {},
      });
      return providerView("provider-1");
    },
    async rotateProviderKey(input) {
      calls.push({ op: "rotate", companyId: input.companyId, providerId: input.providerId, body: input.key });
      await input.activity?.({
        companyId: input.companyId,
        action: "model_provider_key_rotated",
        providerId: input.providerId,
        details: {},
      });
      return providerView(input.providerId);
    },
    async patchProvider(input) {
      calls.push({ op: "patch", companyId: input.companyId, providerId: input.providerId, body: input.body });
      return providerView(input.providerId);
    },
    async removeProvider(input) {
      calls.push({ op: "remove", companyId: input.companyId, providerId: input.providerId });
      await input.activity?.({
        companyId: input.companyId,
        action: "model_provider_removed",
        providerId: input.providerId,
        details: {},
      });
    },
    async listProviders(companyId) {
      calls.push({ op: "list", companyId });
      return [providerView("provider-1")];
    },
    async readProvider(companyId, providerId) {
      calls.push({ op: "read", companyId, providerId });
      return providerView(providerId);
    },
    async listModels(companyId, providerId) {
      calls.push({ op: "listModels", companyId, providerId });
      return [
        { id: "m1", modelName: "model-a", litellmModelName: "openai/model-a", enabled: true, free: false },
        { id: "m2", modelName: "model-b", litellmModelName: "openai/model-b", enabled: true, free: false },
      ];
    },
    async setModels(input) {
      calls.push({ op: "setModels", companyId: input.companyId, providerId: input.providerId, body: input.models });
      return [
        { id: "m1", modelName: "model-a", litellmModelName: "openai/model-a", enabled: false, free: true },
      ];
    },
  };
  return { service, calls };
}

function app(actor: unknown, options: { service?: ModelProviderService } = {}) {
  const fake = fakeService();
  const service = options.service ?? fake.service;
  const activity: Array<{ action: string; providerId: string; companyId: string }> = [];
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    modelProviderRoutes({
      service,
      recordActivity: async (entry) => {
        activity.push({ action: entry.action, providerId: entry.providerId, companyId: entry.companyId });
      },
    }),
  );
  server.use(errorHandler);
  return { server, calls: fake.calls, activity };
}

const base = `/api/myrmidon/companies/${COMPANY_ID}/model-providers`;

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: access", () => {
  it("denies another company on every route (403, no service call)", async () => {
    const { server, calls } = app(outsider);
    await request(server).get(base).expect(403);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(403);
    await request(server).patch(`${base}/provider-1`).send({ free: true }).expect(403);
    await request(server).delete(`${base}/provider-1`).expect(403);
    await request(server).get(`${base}/provider-1/models`).expect(403);
    await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(403);
    expect(calls).toHaveLength(0);
  });

  it("lets an agent of the company read providers and models but not mutate", async () => {
    const { server, calls } = app(agentActor);
    await request(server).get(base).expect(200);
    await request(server).get(`${base}/provider-1/models`).expect(200);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(403);
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(403);
    await request(server).delete(`${base}/provider-1`).expect(403);
    await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(403);
    expect(calls.map((c) => c.op)).toEqual(["list", "listModels"]);
  });

  it("lets a board member of the company do everything", async () => {
    const { server } = app(member);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(201);
    await request(server).get(base).expect(200);
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(200);
    await request(server).delete(`${base}/provider-1`).expect(204);
    await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(200);
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: parsing", () => {
  it("rejects an unknown provider type", async () => {
    const { server, calls } = app(member);
    const response = await request(server)
      .post(base)
      .send({ type: "anthropic", name: "x", key: KEY_VALUE })
      .expect(400);
    expect(response.body.error).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("rejects a create without a key", async () => {
    const { server, calls } = app(member);
    await request(server).post(base).send({ type: "openai", name: "x" }).expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a create with a non-URL baseUrl", async () => {
    const { server, calls } = app(member);
    await request(server)
      .post(base)
      .send({ type: "openai", name: "x", key: KEY_VALUE, baseUrl: "not-a-url" })
      .expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an openai-compatible provider without baseUrl", async () => {
    const { server, calls } = app(member);
    await request(server)
      .post(base)
      .send({ type: "openai-compatible", name: "x", key: KEY_VALUE })
      .expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a models update with an unknown shape", async () => {
    const { server, calls } = app(member);
    await request(server).post(`${base}/provider-1/models`).send({ models: "all" }).expect(400);
    expect(calls).toHaveLength(0);
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: the key is write-only", () => {
  it("never echoes the key value in any response body", async () => {
    const { server } = app(member);
    // The request bodies carry the key; the responses must not.
    const created = await request(server)
      .post(base)
      .send({ type: "openai", name: "p", key: KEY_VALUE })
      .expect(201);
    expect(JSON.stringify(created.body)).not.toContain(KEY_VALUE);

    const listed = await request(server).get(base).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(KEY_VALUE);

    const rotated = await request(server)
      .patch(`${base}/provider-1`)
      .send({ key: KEY_VALUE })
      .expect(200);
    expect(JSON.stringify(rotated.body)).not.toContain(KEY_VALUE);

    const models = await request(server).get(`${base}/provider-1/models`).expect(200);
    expect(JSON.stringify(models.body)).not.toContain(KEY_VALUE);

    const set = await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a" }] })
      .expect(200);
    expect(JSON.stringify(set.body)).not.toContain(KEY_VALUE);
  });

  it("never echoes the key value in an error body either", async () => {
    // A validation error names the offending field, not its value.
    const { server } = app(member);
    const response = await request(server)
      .post(base)
      .send({ type: "openai", name: KEY_VALUE, key: 12345 })
      .expect(400);
    expect(JSON.stringify(response.body)).not.toContain(KEY_VALUE);
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: activity", () => {
  it("forwards add, rotate and remove entries to the activity log", async () => {
    const { server, activity } = app(member);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(201);
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(200);
    await request(server).delete(`${base}/provider-1`).expect(204);
    expect(activity.map((a) => a.action)).toEqual([
      "model_provider_added",
      "model_provider_key_rotated",
      "model_provider_removed",
    ]);
  });
});
