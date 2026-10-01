// myrmidon(CLOUD-CONNECTOR): route tests — plain fakes, no database.
//
// Covers the authorization contract (401 unauthenticated, 403 for an agent on
// the configuration surface), the owner configuration path, the domain
// validation and the agent-facing call path, which must refuse a folder the
// agent was not granted.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { cloudConnectorRoutes } from "./routes.js";
import { cloudConnectorService } from "./service.js";
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

function buildService() {
  let counter = 0;
  return cloudConnectorService({
    providers: new CloudProviderRegistry([new FakeProvider()]),
    store: memoryCloudConnectorStore(),
    now: () => 1_750_000_000_000,
    newId: () => `id-${(counter += 1)}`,
  });
}

function app(actor: unknown, service: ReturnType<typeof buildService>) {
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

async function configured(service: ReturnType<typeof buildService>) {
  await service.connectAccount({ providerId: "onedrive", displayName: "Owner OneDrive", tokenRef: "secret/onedrive" }, "board");
  const work = await service.createRoot({ providerId: "onedrive", name: "work", kind: "own", folder: "Agents/agent-a" }, "board");
  const shared = await service.createRoot(
    { providerId: "onedrive", name: "shared", kind: "shared", driveId: "drive-x", itemId: "item-y" },
    "board",
  );
  await service.setGrant({ rootId: work.id, targetKind: "agent", agentId: agentActor.agentId, mode: "rw" }, "board");
  await service.setGrant({ rootId: shared.id, targetKind: "all", mode: "ro" }, "board");
  return { work, shared };
}

describe("myrmidon(CLOUD-CONNECTOR) routes: authorization", () => {
  it("unauthenticated requests get 401", async () => {
    const server = app(anonymous, buildService());
    await request(server).get("/api/myrmidon/cloud-connector/accounts").expect(401);
    await request(server).get("/api/myrmidon/cloud-connector/roots").expect(401);
  });

  it("an agent never reaches the configuration surface", async () => {
    const service = buildService();
    const server = app(agentActor, service);
    await request(server).get("/api/myrmidon/cloud-connector/accounts").expect(403);
    await request(server).get("/api/myrmidon/cloud-connector/grants").expect(403);
    await request(server).get("/api/myrmidon/cloud-connector/journal").expect(403);
    await request(server).post("/api/myrmidon/cloud-connector/roots").send({ providerId: "onedrive", name: "x", kind: "own", folder: "X" }).expect(403);
  });

  it("a member is refused the owner surface", async () => {
    const server = app(member, buildService());
    await request(server).get(`/api/myrmidon/cloud-connector/accounts${query}`).expect(403);
    await request(server).get(`/api/myrmidon/cloud-connector/journal${query}`).expect(403);
  });
});

describe("myrmidon(CLOUD-CONNECTOR) routes: owner configuration", () => {
  it("connects an account and lists it back", async () => {
    const server = app(owner, buildService());
    await request(server)
      .post(`/api/myrmidon/cloud-connector/accounts${query}`)
      .send({ providerId: "onedrive", displayName: "Owner OneDrive", tokenRef: "secret/onedrive" })
      .expect(201);
    const listed = await request(server).get(`/api/myrmidon/cloud-connector/accounts${query}`).expect(200);
    expect(listed.body.accounts).toHaveLength(1);
  });

  it("validates the account payload", async () => {
    const server = app(owner, buildService());
    await request(server)
      .post(`/api/myrmidon/cloud-connector/accounts${query}`)
      .send({ providerId: "onedrive", displayName: "" })
      .expect(400);
  });

  it("refuses a read-write grant on a shared folder", async () => {
    const service = buildService();
    const { shared } = await configured(service);
    const server = app(owner, service);
    await request(server)
      .put(`/api/myrmidon/cloud-connector/grants${query}`)
      .send({ rootId: shared.id, targetKind: "all", mode: "rw" })
      .expect(400);
  });

  it("returns the folder tree and the journal", async () => {
    const service = buildService();
    await configured(service);
    const server = app(owner, service);
    const tree = await request(server).get(`/api/myrmidon/cloud-connector/tree${query}&providerId=onedrive&root=work`).expect(200);
    expect(tree.body.listing.items[0].name).toBe("a.txt");
    await request(server).get(`/api/myrmidon/cloud-connector/journal${query}`).expect(200);
  });
});

describe("myrmidon(CLOUD-CONNECTOR) routes: agent tool call", () => {
  it("serves the granted folder and refuses the rest", async () => {
    const service = buildService();
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
    const service = buildService();
    await configured(service);
    const server = app(agentActor, service);
    const roots = await request(server).get("/api/myrmidon/cloud-connector/roots").expect(200);
    expect(roots.body.roots.map((root: { name: string }) => root.name).sort()).toEqual(["shared", "work"]);
  });
});