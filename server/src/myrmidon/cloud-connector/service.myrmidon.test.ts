// myrmidon(CLOUD-CONNECTOR): service tests.
//
// These encode the acceptance case end to end at the service boundary: an
// agent reads and writes the folder granted read-write, only reads the shared
// folder, and never reaches another agent's folder — while every attempt,
// allowed or refused, lands in the journal. A fake provider stands in for the
// cloud so no network or key is needed.

import { describe, expect, it } from "vitest";
import { cloudConnectorService, CLOUD_READ_LIMIT_BYTES } from "./service.js";
import { CloudProviderRegistry, type CloudLocation, type CloudProvider, type CloudSearchHit } from "./providers/provider.js";
import { memoryCloudConnectorStore } from "./store.js";
import { joinCloudPath } from "./paths.js";
import type { CloudItem, CloudListing } from "./types.js";

function item(name: string, content: number): CloudItem {
  return { name, type: "file", size: content, modified: "2026-01-01T00:00:00", children: null };
}

class FakeProvider implements CloudProvider {
  readonly id = "onedrive" as const;
  readonly displayName = "OneDrive";
  readonly writes: string[] = [];
  readonly folders: string[] = [];

  async list(location: CloudLocation): Promise<CloudListing> {
    return { path: joinCloudPath(location.parts), items: [item("a.txt", 3)], truncated: false };
  }

  async search(): Promise<CloudSearchHit[]> {
    return [{ path: "a.txt", item: item("a.txt", 3) }];
  }

  async readBytes(location: CloudLocation): Promise<{ item: CloudItem; content: Uint8Array }> {
    return { item: item(location.parts[location.parts.length - 1] ?? "", 3), content: new TextEncoder().encode("hi!") };
  }

  async upload(location: CloudLocation, content: Uint8Array): Promise<CloudItem> {
    const path = joinCloudPath(location.parts);
    this.writes.push(path);
    return item(location.parts[location.parts.length - 1] ?? "", content.byteLength);
  }

  async move(_source: CloudLocation, destination: CloudLocation): Promise<CloudItem> {
    return item(destination.parts[destination.parts.length - 1] ?? "", 3);
  }

  async ensureFolder(location: CloudLocation): Promise<CloudItem> {
    const path = joinCloudPath(location.parts) || "root";
    this.folders.push(path);
    return { name: path, type: "folder", size: null, modified: null, children: 0 };
  }
}

function build() {
  const provider = new FakeProvider();
  const store = memoryCloudConnectorStore();
  let counter = 0;
  const service = cloudConnectorService({
    providers: new CloudProviderRegistry([provider]),
    store,
    now: () => 1_750_000_000_000,
    newId: () => `id-${(counter += 1)}`,
  });
  return { provider, store, service };
}

const agentA = { agentId: "agent-a", caste: null };
const agentB = { agentId: "agent-b", caste: null };

async function seed(service: ReturnType<typeof build>["service"]) {
  await service.connectAccount({ providerId: "onedrive", displayName: "Owner OneDrive", tokenRef: "secret/onedrive" }, "board");
  const work = await service.createRoot({ providerId: "onedrive", name: "work", kind: "own", folder: "Agents/agent-a" }, "board");
  const shared = await service.createRoot(
    { providerId: "onedrive", name: "shared", kind: "shared", driveId: "drive-x", itemId: "item-y" },
    "board",
  );
  const secret = await service.createRoot({ providerId: "onedrive", name: "secret", kind: "own", folder: "Agents/agent-b" }, "board");
  await service.setGrant({ rootId: work.id, targetKind: "agent", agentId: "agent-a", mode: "rw" }, "board");
  await service.setGrant({ rootId: shared.id, targetKind: "all", mode: "ro" }, "board");
  await service.setGrant({ rootId: secret.id, targetKind: "agent", agentId: "agent-b", mode: "rw" }, "board");
  return { work, shared, secret };
}

describe("cloud connector service", () => {
  it("refuses read-write on a shared folder when the owner grants it", async () => {
    const { service } = build();
    const { shared } = await seed(service);
    await expect(service.setGrant({ rootId: shared.id, targetKind: "all", mode: "rw" }, "board")).rejects.toThrow(/read-only/);
  });

  it("lists only the roots this agent was granted", async () => {
    const { service } = build();
    await seed(service);
    const access = await service.accessFor(agentA);
    expect(access.map((entry) => entry.root.name).sort()).toEqual(["shared", "work"]);
  });

  it("gives the agent its own read-write folder on first use", async () => {
    const { service, provider } = build();
    await seed(service);
    const root = await service.ensurePersonalRoot("onedrive", "agent-c", "board");
    expect(root.personalForAgentId).toBe("agent-c");
    expect(root.folder).toBe("Agents/agent-c");
    const access = await service.accessFor({ agentId: "agent-c", caste: null });
    const personal = access.find((entry) => entry.root.personalForAgentId === "agent-c");
    expect(personal).toMatchObject({ mode: "rw", via: "agent" });
    // the folder is created before the grant is written, and only for this agent
    expect(provider.folders).toContain("root");
    const otherAgent = await service.accessFor({ agentId: "agent-d", caste: null });
    expect(otherAgent.map((entry) => entry.root.name)).toEqual(["shared"]);
  });

  it("reads and writes the granted folder", async () => {
    const { service, provider } = build();
    await seed(service);

    const listed = await service.callTool(agentA, { tool: "cloud_list", root: "work", path: "" });
    expect(listed.ok).toBe(true);

    const uploaded = await service.callTool(agentA, {
      tool: "cloud_upload",
      root: "work",
      path: "notes.txt",
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    expect(uploaded.ok).toBe(true);
    expect(provider.writes).toEqual(["notes.txt"]);
  });

  it("only reads the shared folder", async () => {
    const { service } = build();
    await seed(service);

    const read = await service.callTool(agentA, { tool: "cloud_read", root: "shared", path: "a.txt" });
    expect(read.ok).toBe(true);

    const write = await service.callTool(agentA, {
      tool: "cloud_upload",
      root: "shared",
      path: "a.txt",
      contentBase64: Buffer.from("nope").toString("base64"),
    });
    expect(write).toMatchObject({ ok: false });
    expect(write.error).toMatch(/read-only/);
  });

  it("never reaches another agent's folder", async () => {
    const { service, provider } = build();
    await seed(service);
    const denied = await service.callTool(agentA, { tool: "cloud_list", root: "secret", path: "" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("not granted");
    expect(provider.writes).toEqual([]);
  });

  it("refuses to move from a read-only root", async () => {
    const { service } = build();
    await seed(service);
    const denied = await service.callTool(agentA, { tool: "cloud_move", root: "shared", path: "a.txt", toRoot: "work", toPath: "a.txt" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/read-only/);
  });

  it("journals allowed and refused calls without file contents", async () => {
    const { service } = build();
    await seed(service);
    await service.callTool(agentA, {
      tool: "cloud_upload",
      root: "work",
      path: "notes.txt",
      contentBase64: Buffer.from("top-secret-payload").toString("base64"),
    });
    await service.callTool(agentA, { tool: "cloud_list", root: "secret", path: "" });

    const journal = await service.journal();
    expect(journal.length).toBeGreaterThanOrEqual(2);
    const refused = journal.find((entry) => !entry.ok);
    expect(refused).toMatchObject({ tool: "cloud_list", rootName: "secret", actor: "agent-a" });
    expect(JSON.stringify(journal)).not.toContain("top-secret-payload");
  });

  it("keeps the read limit for text reads", async () => {
    const { service } = build();
    await seed(service);
    const read = await service.callTool(agentA, { tool: "cloud_read", root: "work", path: "a.txt" });
    const result = read.result as { contentBase64: string };
    expect(Buffer.from(result.contentBase64, "base64").toString("utf8")).toBe("hi!");
    expect(CLOUD_READ_LIMIT_BYTES).toBeLessThan(1024 * 1024);
  });

  it("refuses a traversal in the path", async () => {
    const { service } = build();
    await seed(service);
    const denied = await service.callTool(agentA, { tool: "cloud_list", root: "work", path: "../secret" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/\.\./);
  });

  it("removes the grants when a root is removed", async () => {
    const { service } = build();
    const { secret } = await seed(service);
    await service.removeRoot(secret.id);
    expect(await service.listGrants()).not.toContainEqual(expect.objectContaining({ rootId: secret.id }));
    const access = await service.accessFor(agentB);
    expect(access.map((entry) => entry.root.name)).toEqual(["shared"]);
  });

  it("rejects a duplicate folder name per provider", async () => {
    const { service } = build();
    await seed(service);
    await expect(
      service.createRoot({ providerId: "onedrive", name: "work", kind: "own", folder: "Other" }, "board"),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an unknown provider", async () => {
    const { service } = build();
    await expect(
      service.createRoot({ providerId: "dropbox" as never, name: "x", kind: "own", folder: "X" }, "board"),
    ).rejects.toThrow(/unknown cloud provider/);
  });
});