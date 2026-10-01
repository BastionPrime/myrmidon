// myrmidon(CLOUD-CONNECTOR): route tests — plain fakes, no database.
//
// Covers the authorization contract (401 unauthenticated, 403 for an agent on
// the configuration surface), the owner connect flow (start returns the
// provider URL, the callback stores the token in the connector's secret and
// records the account), the domain validation, and the agent-facing call path,
// which must refuse a folder the agent was not granted.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { cloudConnectorRoutes } from "./routes.js";
import { cloudConnectorService, type CloudConnectorService } from "./service.js";
import { OAuthStateStore } from "./oauth.js";
import { memoryCloudTokenStore } from "./token-store.js";
import { CloudProviderRegistry, type CloudLocation, type CloudProvider, type CloudSearchHit } from "./providers/provider.js";
import { memoryCloudConnectorStore } from "./store.js";
import type { CloudItem, CloudListing } from "./types.js";

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
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};
const anonymous = { type: "none" };

class FakeProvider implements CloudProvider {
  readonly id = "onedrive" as const;
  readonly displayName = "OneDrive";
  async list(location: CloudLocation): Promise<CloudListing> {
    return { path: location.parts.join("/"), items: [item("a.txt")], truncated: false };
  }
  async search(): Promise<CloudSearchHit[]> {
    return [{ path: "a.txt", item: item("a.txt") }];
  }
  async readBytes(): Promise<{ item: CloudItem; content: Uint8Array }> {
    return { item: item("a.txt"), content: new TextEncoder().encode("hi!") };
  }
  async upload(): Promise<CloudItem> {
    return item("a.txt");
  }
  async move(): Promise<CloudItem> {
    return item("a.txt");
  }
  async ensureFolder(): Promise<CloudItem> {
    return { name: "root", type: "folder", size: null, modified: null, children: 0 };
  }
}

function item(name: string): CloudItem {
  return { name, type: "file", size: 3, modified: "2026-01-01T00:00:00", children: null };
}

const tokenResponse = () =>
  new Response(
    JSON.stringify({ access_token: "token-a", refresh_token: "refresh-a", expires_in: 3600, token_type: "Bearer", scope: "Files.ReadWrite.All" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

interface Harness {
  service: CloudConnectorService;
  tokenStore: ReturnType<typeof memoryCloudTokenStore>;
  stateStore: OAuthStateStore;
}

function buildService(): Harness {
  let counter = 0;
  const tokenStore = memoryCloudTokenStore();
  const stateStore = new OAuthStateStore();
  const service = cloudConnectorService({
    providers: new CloudProviderRegistry([new FakeProvider()]),
    store: memoryCloudConnectorStore(),
    now: () => 1_750_000_000_000,
    newId: () => `id-${(counter += 1)}`,
    oauth: {
      clients: { onedrive: { clientId: "client-a", clientSecret: "shh", redirectUri: "https://board.example.com/api/myrmidon/cloud-connector/oauth/callback" } },
      stateStore,
      tokenStore,
      fetchImpl: (async () => tokenResponse()) as unknown as typeof fetch,
    },
  });
  return { service, tokenStore, stateStore };
}

function app(actor: unknown, service: CloudConnectorService) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", cloudConnectorRoutes({ service }));
  server.use(errorHandler);
  return server;
}

const query = `?companyId=${COMPANY_ID}`;

async function configured(service: CloudConnectorService) {
  await service.connectAccount(
    { providerId: "onedrive", displayName: "Owner OneDrive", companyId: COMPANY_ID, tokenRef: "secret-a" },
    "user-owner",
  );
  const work = await service.createRoot(
    { providerId: "onedrive", companyId: COMPANY_ID, name: "work", kind: "own", folder: "Agents/agent-a" },
    "user-owner",
  );
  const shared = await service.createRoot(
    { providerId: "onedrive", companyId: COMPANY_ID, name: "shared", kind: "shared", driveId: "drive-x", itemId: "item-y" },
    "user-owner",
  );
  await service.setGrant({ rootId: work.id, targetKind: "agent", agentId: agentActor.agentId, mode: "rw" }, "user-owner");
  await service.setGrant({ rootId: shared.id, targetKind: "all", mode: "ro" }, "user-owner");
  return { work, shared };
}

describe("myrmidon(CLOUD-CONNECTOR) routes: authorization", () => {
  it("unauthenticated requests get 401", async () => {
    const server = app(anonymous, buildService().service);
    await request(server).get("/api/myrmidon/cloud-connector/accounts").expect(401);
    await request(server).get("/api/myrmidon/cloud-connector/roots").expect(401);
    await request(server).get("/api/myrmidon/cloud-connector/oauth/callback?code=a&state=b").expect(401);
  });

  it("an agent never reaches the configuration surface", async () => {
    const server = app(agentActor, buildService().service);
    await request(server).get("/api/myrmidon/cloud-connector/accounts").expect(403);
    await request(server).get("/api/myrmidon/cloud-connector/grants").expect(403);
    await request(server).get("/api/myrmidon/cloud-connector/journal").expect(403);
    await request(server)
      .post(`/api/myrmidon/cloud-connector/oauth/onedrive/start${query}`)
      .send({ companyId: COMPANY_ID })
      .expect(403);
  });

  it("a member is refused the owner surface", async () => {
    const server = app(member, buildService().service);
    await request(server).get(`/api/myrmidon/cloud-connector/accounts${query}`).expect(403);
    await request(server).get(`/api/myrmidon/cloud-connector/journal${query}`).expect(403);
  });
});

describe("myrmidon(CLOUD-CONNECTOR) routes: owner connect flow", () => {
  it("start answers the provider URL with the single-use state", async () => {
    const server = app(owner, buildService().service);
    const started = await request(server)
      .post(`/api/myrmidon/cloud-connector/oauth/onedrive/start${query}`)
      .send({ companyId: COMPANY_ID, displayName: "Owner OneDrive" })
      .expect(200);
    const url = new URL(started.body.authorizeUrl);
    expect(url.host).toBe("login.microsoftonline.com");
    expect(url.searchParams.get("client_id")).toBe("client-a");
    expect(url.searchParams.get("state")).toBe(started.body.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("validates the start payload", async () => {
    const server = app(owner, buildService().service);
    await request(server).post(`/api/myrmidon/cloud-connector/oauth/onedrive/start${query}`).send({}).expect(400);
  });

  it("the callback stores the token in the secret and records the account", async () => {
    const { service, tokenStore, stateStore } = buildService();
    const started = await service.beginConnect({ providerId: "onedrive", companyId: COMPANY_ID, userId: "user-owner" });
    const server = app(owner, service);

    const done = await request(server)
      .get(`/api/myrmidon/cloud-connector/oauth/callback?code=code-a&state=${started.state}`)
      .expect(200);
    expect(done.body.account).toMatchObject({ providerId: "onedrive", companyId: COMPANY_ID });
    // the token is in the connector's secret, and only the id is in the account
    expect(done.body.account.tokenRef).toBe("secret-1");
    expect(JSON.stringify(done.body)).not.toContain("token-a");
    const stored = await tokenStore.read(COMPANY_ID, "secret-1");
    expect(stored?.value).toContain("refresh-a");

    // the state is single use
    await request(server).get(`/api/myrmidon/cloud-connector/oauth/callback?code=code-a&state=${started.state}`).expect(400);
    expect(stateStore.consume(started.state)).toBeNull();
  });

  it("refuses a callback without a known state", async () => {
    const server = app(owner, buildService().service);
    await request(server).get("/api/myrmidon/cloud-connector/oauth/callback?code=code-a&state=forged").expect(400);
  });

  it("reports a provider refusal as a bad request", async () => {
    const { service, stateStore } = buildService();
    const state = stateStore.issue({ providerId: "onedrive", companyId: COMPANY_ID, userId: "user-owner", verifier: null });
    const failing = cloudConnectorService({
      providers: new CloudProviderRegistry([new FakeProvider()]),
      store: memoryCloudConnectorStore(),
      oauth: {
        clients: { onedrive: { clientId: "client-a", clientSecret: null, redirectUri: "https://board.example.com/cb" } },
        stateStore,
        tokenStore: memoryCloudTokenStore(),
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      },
    });
    const server = app(owner, failing);
    await request(server).get(`/api/myrmidon/cloud-connector/oauth/callback?code=bad&state=${state}`).expect(400);
    expect(service).toBeTruthy();
  });
});

describe("myrmidon(CLOUD-CONNECTOR) routes: owner configuration", () => {
  it("lists the connected accounts of the company", async () => {
    const { service } = buildService();
    await configured(service);
    const server = app(owner, service);
    const listed = await request(server).get(`/api/myrmidon/cloud-connector/accounts${query}`).expect(200);
    expect(listed.body.accounts).toHaveLength(1);
    expect(listed.body.accounts[0].tokenRef).toBe("secret-a");
  });

  it("refuses a read-write grant on a shared folder", async () => {
    const { service } = buildService();
    const { shared } = await configured(service);
    const server = app(owner, service);
    await request(server)
      .put(`/api/myrmidon/cloud-connector/grants${query}`)
      .send({ rootId: shared.id, targetKind: "all", mode: "rw" })
      .expect(400);
  });

  it("returns the folder tree and the journal", async () => {
    const { service } = buildService();
    await configured(service);
    const server = app(owner, service);
    const tree = await request(server).get(`/api/myrmidon/cloud-connector/tree${query}&providerId=onedrive&root=work`).expect(200);
    expect(tree.body.listing.items[0].name).toBe("a.txt");
    await request(server).get(`/api/myrmidon/cloud-connector/journal${query}`).expect(200);
  });
});

describe("myrmidon(CLOUD-CONNECTOR) routes: agent tool call", () => {
  it("serves the granted folder and refuses the rest", async () => {
    const { service } = buildService();
    await configured(service);
    const server = app(agentActor, service);

    const allowed = await request(server)
      .post("/api/myrmidon/cloud-connector/call")
      .send({ tool: "cloud_list", root: "work", path: "" })
      .expect(200);
    expect(allowed.body.result.ok).toBe(true);

    const refused = await request(server)
      .post("/api/myrmidon/cloud-connector/call")
      .send({ tool: "cloud_list", root: "other", path: "" })
      .expect(200);
    expect(refused.body.result).toMatchObject({ ok: false });
  });

  it("lists the granted roots to the agent only", async () => {
    const { service } = buildService();
    await configured(service);
    const server = app(agentActor, service);
    const roots = await request(server).get("/api/myrmidon/cloud-connector/roots").expect(200);
    expect(roots.body.roots.map((root: { name: string }) => root.name).sort()).toEqual(["shared", "work"]);
  });
});