// server/src/myrmidon/model-providers/model-providers.db.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A): the service against a real database —
// the schema, the write-only secret path, key validation and the model cache.
//
// The secret store is a fake (values in a Map) so the suite does not depend on
// the encryption master key; the service only needs the store's interface.
// The provider catalog is a fake too: what matters here is that the service
// calls it with the CANDIDATE key and stores what it answered.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, modelProviderModels, modelProviders } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  createModelProviderService,
  ProviderAuthError,
  type ModelProviderCatalogPort,
  type ModelProviderSecretStoreDeps,
} from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const KEY_VALUE = "sk-db-suite-provider-key";
const ROTATED_VALUE = "sk-db-suite-rotated-key";

function fakeSecrets(): ModelProviderSecretStoreDeps & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    readSecretValue: async (_companyId, name) => store.get(name) ?? null,
    findSecretId: async (_companyId, name) => (store.has(name) ? `id-${name}` : null),
    createSecret: async ({ name, value }) => {
      store.set(name, value);
      return { id: `id-${name}` };
    },
    rotateSecret: async (secretId, value) => {
      store.set(secretId.replace(/^id-/, ""), value);
    },
    deleteSecret: async (secretId) => {
      store.delete(secretId.replace(/^id-/, ""));
    },
  };
}

function fakeCatalog(): ModelProviderCatalogPort & {
  calls: Array<{ baseUrl: string; apiKey: string }>;
} {
  const calls: Array<{ baseUrl: string; apiKey: string }> = [];
  return {
    calls,
    async listModels({ baseUrl, apiKey }) {
      calls.push({ baseUrl, apiKey });
      if (apiKey === "bad-key") throw new ProviderAuthError("the provider answered 401");
      if (apiKey === ROTATED_VALUE) return { models: ["model-x", "model-y", "model-z"] };
      return { models: ["model-a", "model-b"] };
    },
  };
}

describeEmbeddedPostgres("myrmidon(1.6.1 MODEL-PROVIDERS) service over the database", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-model-providers-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(modelProviderModels);
    await db.delete(modelProviders);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeService() {
    const secrets = fakeSecrets();
    const catalog = fakeCatalog();
    const activity: Array<{ action: string; providerId: string }> = [];
    const service = createModelProviderService({
      db,
      secrets,
      catalog,
      now: () => new Date("2026-01-02T00:00:00Z"),
    });
    return { service, secrets: secrets.store, catalog, activity };
  }

  async function makeCompany(): Promise<string> {
    const row = await db
      .insert(companies)
      .values({
        name: `company ${randomUUID()}`,
        issuePrefix: `MP${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  it("creates a provider: row + secret + model cache, key never in the DB", async () => {
    companyId = await makeCompany();
    const { service, secrets, catalog, activity } = makeService();
    const view = await service.createProvider({
      companyId,
      body: { type: "dashscope", name: "DashScope prod", key: KEY_VALUE, baseUrl: null },
    });

    expect(catalog.calls).toEqual([
      { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKey: KEY_VALUE },
    ]);
    expect(view.hasKey).toBe(true);
    expect(view.credentialSecretName).toBe(`model-provider-key-${view.id}`);
    expect(secrets.get(view.credentialSecretName!)).toBe(KEY_VALUE);
    expect(activity.map((a) => a.action)).toEqual(["model_provider_added"]);

    // The database row references the secret name and holds no value.
    const row = (await db.select().from(modelProviders))[0]!;
    expect(row.credentialSecretName).toBe(view.credentialSecretName);
    expect(JSON.stringify(row)).not.toContain(KEY_VALUE);

    // The model cache was written from the catalog answer.
    const models = await service.listModels(companyId, view.id);
    expect(models.map((m) => m.modelName).sort()).toEqual(["model-a", "model-b"]);
    expect(models[0].litellmModelName).toBe("dashscope/model-a");
  });

  it("refuses an invalid key with a 4xx and writes nothing", async () => {
    companyId = await makeCompany();
    const { service, secrets } = makeService();
    await expect(
      service.createProvider({ companyId, body: { type: "openai", name: "p", key: "bad-key", baseUrl: null } }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await db.select().from(modelProviders))).toHaveLength(0);
    expect(secrets.size).toBe(0);
  });

  it("refuses a duplicate name per company and isolates companies", async () => {
    companyId = await makeCompany();
    const other = await makeCompany();
    const { service } = makeService();
    await service.createProvider({ companyId, body: { type: "openai", name: "dup", key: KEY_VALUE, baseUrl: null } });
    await expect(
      service.createProvider({ companyId, body: { type: "openai", name: "dup", key: KEY_VALUE, baseUrl: null } }),
    ).rejects.toMatchObject({ status: 409 });
    // The same name in another company is fine.
    await service.createProvider({ companyId: other, body: { type: "openai", name: "dup", key: KEY_VALUE, baseUrl: null } });
    const views = await service.listProviders(companyId);
    expect(views).toHaveLength(1);
  });

  it("rotates the key: validation first, store and cache move", async () => {
    companyId = await makeCompany();
    const { service, secrets, catalog, activity } = makeService();
    const created = await service.createProvider({
      companyId,
      body: { type: "openai", name: "p", key: KEY_VALUE, baseUrl: null },
    });

    const rotated = await service.rotateProviderKey({ companyId, providerId: created.id, key: ROTATED_VALUE });
    expect(rotated.hasKey).toBe(true);
    expect(secrets.get(created.credentialSecretName!)).toBe(ROTATED_VALUE);
    expect(catalog.calls.at(-1)?.apiKey).toBe(ROTATED_VALUE);
    // The cache was replaced with the new snapshot.
    const models = await service.listModels(companyId, created.id);
    expect(models.map((m) => m.modelName).sort()).toEqual(["model-x", "model-y", "model-z"]);
    expect(activity.at(-1)?.action).toBe("model_provider_key_rotated");

    // A bad rotation leaves everything as it was.
    await expect(
      service.rotateProviderKey({ companyId, providerId: created.id, key: "bad-key" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(secrets.get(created.credentialSecretName!)).toBe(ROTATED_VALUE);
    expect((await service.listModels(companyId, created.id))).toHaveLength(3);
  });

  it("removes the provider, its cache and its secret", async () => {
    companyId = await makeCompany();
    const { service, secrets, activity } = makeService();
    const created = await service.createProvider({
      companyId,
      body: { type: "openai", name: "p", key: KEY_VALUE, baseUrl: null },
    });
    await service.removeProvider({ companyId, providerId: created.id });

    expect((await db.select().from(modelProviders))).toHaveLength(0);
    expect((await db.select().from(modelProviderModels))).toHaveLength(0);
    expect(secrets.size).toBe(0);
    expect(activity.at(-1)?.action).toBe("model_provider_removed");
    await expect(service.readProvider(companyId, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("applies per-model enable/disable switches", async () => {
    companyId = await makeCompany();
    const { service } = makeService();
    const created = await service.createProvider({
      companyId,
      body: { type: "openai", name: "p", key: KEY_VALUE, baseUrl: null },
    });
    const updated = await service.setModels({
      companyId,
      providerId: created.id,
      models: [{ modelName: "model-b", enabled: false, free: true }],
    });
    const modelB = updated.find((m) => m.modelName === "model-b")!;
    expect(modelB.enabled).toBe(false);
    expect(modelB.free).toBe(true);
    const modelA = updated.find((m) => m.modelName === "model-a")!;
    expect(modelA.enabled).toBe(true);
  });

  it("reports hasKey false when the secret is gone and never leaks the value", async () => {
    companyId = await makeCompany();
    const { service, secrets } = makeService();
    const created = await service.createProvider({
      companyId,
      body: { type: "openai", name: "p", key: KEY_VALUE, baseUrl: null },
    });
    secrets.clear();
    const views = await service.listProviders(companyId);
    expect(views[0].hasKey).toBe(false);
    expect(JSON.stringify(views)).not.toContain(KEY_VALUE);
    expect(Object.keys(views[0]).sort()).toEqual(
      [
        "id",
        "type",
        "name",
        "baseUrl",
        "hasKey",
        "credentialSecretName",
        "free",
        "keyValidatedAt",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });
});
