// myrmidon(CLOUD-CONNECTOR): the agent MCP surface tests.
//
// The MCP endpoint is the only way an agent reaches the cloud, so these tests
// pin what the agent sees: the six tools, the call that actually runs (through
// the same service, hence the same grants and the same journal), and the text
// of a refusal — a missing grant, a read-only folder, a missing argument and a
// bad argument all have to be distinguishable from "the cloud said no".

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { cloudConnectorMcpRoutes } from "./mcp.js";
import { cloudConnectorService, type CloudConnectorService } from "./service.js";
import { memoryCloudConnectorStore } from "./store.js";
import {
  CloudProviderRegistry,
  type CloudLocation,
  type CloudProvider,
  type CloudSearchHit,
} from "./providers/provider.js";
import type { CloudItem, CloudListing } from "./types.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
};
const boardActor = { type: "board", source: "session", userId: "user-owner", companyIds: [COMPANY_ID] };
const anonymous = { type: "none" };

function item(name: string): CloudItem {
  return { name, type: "file", size: 3, modified: null, children: null };
}

class FakeProvider implements CloudProvider {
  readonly id = "onedrive" as const;
  readonly displayName = "OneDrive";
  calls: string[] = [];
  async list(location: CloudLocation): Promise<CloudListing> {
    this.calls.push(`list ${location.parts.join("/")}`);
    return { path: location.parts.join("/"), items: [item("a.txt")], truncated: false };
  }
  async search(_location: CloudLocation, query: string): Promise<CloudSearchHit[]> {
    this.calls.push(`search ${query}`);
    return [{ path: "a.txt", item: item("a.txt") }];
  }
  async readBytes(): Promise<{ item: CloudItem; content: Uint8Array }> {
    this.calls.push("read");
    return { item: item("a.txt"), content: new TextEncoder().encode("hi!") };
  }
  async upload(): Promise<CloudItem> {
    this.calls.push("upload");
    return item("notes.txt");
  }
  async move(): Promise<CloudItem> {
    this.calls.push("move");
    return item("notes.txt");
  }
  async ensureFolder(): Promise<CloudItem> {
    return { name: "sub", type: "folder", size: null, modified: null, children: null };
  }
}

interface Harness {
  service: CloudConnectorService;
  provider: FakeProvider;
}

function buildService(): Harness {
  let counter = 0;
  const provider = new FakeProvider();
  const service = cloudConnectorService({
    providers: new CloudProviderRegistry([provider]),
    store: memoryCloudConnectorStore(),
    now: () => 1_750_000_000_000,
    newId: () => `id-${(counter += 1)}`,
  });
  return { service, provider };
}

/** The owner's setup from the acceptance criteria: own root rw, shared root ro. */
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
  await service.setGrant({ rootId: work.id, targetKind: "agent", agentId: AGENT_ID, mode: "rw" }, "user-owner");
  await service.setGrant({ rootId: shared.id, targetKind: "all", mode: "ro" }, "user-owner");
  return { work, shared };
}

function app(actor: unknown, service: CloudConnectorService) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", cloudConnectorMcpRoutes({ service }));
  server.use(errorHandler);
  return server;
}

function call(name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

describe("myrmidon(CLOUD-CONNECTOR) MCP surface", () => {
  it("answers initialize with the protocol version", async () => {
    const server = app(agentActor, buildService().service);
    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" })
      .expect(200);
    expect(response.body.result.protocolVersion).toBe("2025-03-26");
    expect(response.body.result.serverInfo.name).toBe("myrmidon-cloud-connector");
  });

  it("lists the six cloud tools with the arguments each one needs", async () => {
    const server = app(agentActor, buildService().service);
    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(200);
    const tools = response.body.result.tools as Array<{ name: string; inputSchema: { required: string[] } }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "cloud_list",
      "cloud_search",
      "cloud_read",
      "cloud_download",
      "cloud_upload",
      "cloud_move",
    ]);
    expect(tools.find((tool) => tool.name === "cloud_upload")?.inputSchema.required).toEqual([
      "root",
      "path",
      "contentBase64",
    ]);
    expect(tools.find((tool) => tool.name === "cloud_list")?.inputSchema.required).toEqual(["root"]);
  });

  it("runs a granted call as the agent and answers with its result", async () => {
    const harness = buildService();
    await configured(harness.service);
    const server = app(agentActor, harness.service);

    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_list", { root: "work" }))
      .expect(200);

    expect(response.body.result.isError).toBeUndefined();
    expect(response.body.result.structuredContent).toMatchObject({ ok: true, tool: "cloud_list", root: "work" });
    expect(response.body.result.content[0].text).toContain("a.txt");
    expect(harness.provider.calls).toEqual(["list "]);

    const journal = await harness.service.journal();
    expect(journal[0]).toMatchObject({ actor: AGENT_ID, tool: "cloud_list", ok: true });
  });

  it("answers a read-only folder with the boundary the agent hit, and journals it", async () => {
    const harness = buildService();
    await configured(harness.service);
    const server = app(agentActor, harness.service);

    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_upload", { root: "shared", path: "notes.txt", contentBase64: "aGkh" }))
      .expect(200);

    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toMatch(/read-only/i);
    expect(harness.provider.calls).toEqual([]);

    const journal = await harness.service.journal();
    expect(journal[0]).toMatchObject({ actor: AGENT_ID, tool: "cloud_upload", ok: false });
  });

  it("refuses a folder the agent was not granted", async () => {
    const harness = buildService();
    await configured(harness.service);
    const server = app(agentActor, harness.service);

    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_list", { root: "someone-elses" }))
      .expect(200);

    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toMatch(/no access/i);
    expect(harness.provider.calls).toEqual([]);
  });

  it("names the missing argument instead of failing generically", async () => {
    const harness = buildService();
    await configured(harness.service);
    const server = app(agentActor, harness.service);

    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_read", { root: "work" }))
      .expect(200);

    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toBe("cloud_read needs path");
    expect(harness.provider.calls).toEqual([]);
  });

  it("turns a badly typed argument into a readable refusal that names the argument", async () => {
    const harness = buildService();
    await configured(harness.service);
    const server = app(agentActor, harness.service);

    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_list", { root: "work", path: { nested: true } }))
      .expect(200);

    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toContain("cloud_list");
    expect(response.body.result.content[0].text).toContain("path");
    expect(harness.provider.calls).toEqual([]);
  });

  it("answers an unknown tool with the tool's name", async () => {
    const server = app(agentActor, buildService().service);
    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_delete_everything", { root: "work" }))
      .expect(200);
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toContain("cloud_delete_everything");
  });

  it("answers an unknown method with -32601", async () => {
    const server = app(agentActor, buildService().service);
    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send({ jsonrpc: "2.0", id: 3, method: "resources/list" })
      .expect(200);
    expect(response.body.error.code).toBe(-32601);
  });

  it("serves agents only: a board user and an anonymous caller get 401", async () => {
    const service = buildService().service;
    const toolsList = { jsonrpc: "2.0", id: 4, method: "tools/list" };
    await request(app(boardActor, service)).post("/api/mcp/cloud-tools").send(toolsList).expect(401);
    await request(app(anonymous, service)).post("/api/mcp/cloud-tools").send(toolsList).expect(401);
    // not even the handshake is served to a caller that is not an agent
    await request(app(anonymous, service))
      .post("/api/mcp/cloud-tools")
      .send({ jsonrpc: "2.0", id: 5, method: "initialize" })
      .expect(401);
  });

  it("hands the agent its own folder when it asks for the reserved name", async () => {
    const { service, provider } = buildService();
    await configured(service);
    const server = app(agentActor, service);

    const response = await request(server).post("/api/mcp/cloud-tools").send(call("cloud_list", { root: "personal", path: "" })).expect(200);
    expect(response.body.result.isError).toBeUndefined();
    expect(provider.calls).toContain("list ");

    const denied = await request(server)
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_upload", { root: "personal", path: "denied.txt", contentBase64: "", overwrite: false }))
      .expect(200);
    // the folder exists and is this agent's own: the refusal here is the
    // argument check, not an access one — access was granted on the first call
    expect(denied.body.result.content[0].text).not.toMatch(/no access to folder/);
  });

  it("accepts the reserved name as the destination of a move", async () => {
    const { service, provider } = buildService();
    await configured(service);
    const response = await request(app(agentActor, service))
      .post("/api/mcp/cloud-tools")
      .send(call("cloud_move", { root: "work", path: "a.txt", toRoot: "personal", toPath: "a.txt" }))
      .expect(200);
    expect(response.body.result.isError).toBeUndefined();
    expect(JSON.stringify(response.body.result)).not.toMatch(/no access to folder/);
    expect(provider.calls).toContain("move");
  });

  it("tells the agent in tools/list that the reserved name exists", async () => {
    const server = app(agentActor, buildService().service);
    const response = await request(server)
      .post("/api/mcp/cloud-tools")
      .send({ jsonrpc: "2.0", id: 6, method: "tools/list" })
      .expect(200);
    const listTool = response.body.result.tools.find((tool: { name: string }) => tool.name === "cloud_list");
    expect(listTool.inputSchema.properties.root.description).toContain("personal");
  });
});