// myrmidon(CLOUD-CONNECTOR): service tests.
//
// These encode the acceptance case end to end at the service boundary: an
// agent reads and writes the folder granted read-write, only reads the shared
// folder, and never reaches another agent's folder — while every attempt,
// allowed or refused, lands in the journal. A fake provider stands in for the
// cloud so no network or key is needed.

import { describe, expect, it } from "vitest";
import type { CloudProviderId } from "@paperclipai/shared/myrmidon-cloud-connector";
import { cloudConnectorService, CLOUD_READ_LIMIT_BYTES } from "./service.js";
import { CloudProviderRegistry, type CloudLocation, type CloudProvider, type CloudSearchHit } from "./providers/provider.js";
import { memoryCloudConnectorStore } from "./store.js";
import { joinCloudPath } from "./paths.js";
import type { CloudItem, CloudListing } from "./types.js";

function item(name: string, content: number): CloudItem {
  return { name, type: "file", size: content, modified: "2026-01-01T00:00:00", children: null };
}

class FakeProvider implements CloudProvider {
  readonly id: CloudProviderId;
  readonly displayName: string;
  readonly writes: string[] = [];
  readonly folders: string[] = [];

  constructor(id: CloudProviderId = "onedrive", displayName = "OneDrive") {
    this.id = id;
    this.displayName = displayName;
  }

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

function build(options: { agentRole?: (agentId: string) => Promise<string | null>; providers?: CloudProvider[] } = {}) {
  const provider = new FakeProvider();
  const store = memoryCloudConnectorStore();
  let counter = 0;
  const service = cloudConnectorService({
    providers: new CloudProviderRegistry([provider, ...(options.providers ?? [])]),
    store,
    agentRole: options.agentRole,
    now: () => 1_750_000_000_000,
    newId: () => `id-${(counter += 1)}`,
  });
  return { provider, store, service };
}

const agentA = { agentId: "agent-a", caste: null };
const agentB = { agentId: "agent-b", caste: null };
const agentC = { agentId: "agent-c", companyId: "company-a", caste: null };
const agentBInCompany = { agentId: "agent-b", companyId: "company-a", caste: null };

async function seed(service: ReturnType<typeof build>["service"]) {
  await service.connectAccount({ providerId: "onedrive", displayName: "Owner OneDrive", companyId: "company-a", tokenRef: "secret/onedrive" }, "board");
  const work = await service.createRoot({ providerId: "onedrive", companyId: "company-a", name: "work", kind: "own", folder: "Agents/agent-a" }, "board");
  const shared = await service.createRoot(
    { providerId: "onedrive", companyId: "company-a", name: "shared", kind: "shared", driveId: "drive-x", itemId: "item-y" },
    "board",
  );
  const secret = await service.createRoot({ providerId: "onedrive", companyId: "company-a", name: "secret", kind: "own", folder: "Agents/agent-b" }, "board");
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
    const root = await service.ensurePersonalRoot("onedrive", "company-a", "agent-c", "board");
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
      service.createRoot({ providerId: "onedrive", companyId: "company-a", name: "work", kind: "own", folder: "Other" }, "board"),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an unknown provider", async () => {
    const { service } = build();
    await expect(
      service.createRoot({ providerId: "dropbox" as never, companyId: "company-a", name: "x", kind: "own", folder: "X" }, "board"),
    ).rejects.toThrow(/unknown cloud provider/);
  });

  it("creates the agent's own folder the first time it uses the reserved name, and reuses it after that", async () => {
    const { service, provider } = build();
    await seed(service);

    const first = await service.callTool(agentC, { tool: "cloud_list", root: "personal", path: "" });
    expect(first.ok).toBe(true);
    // the fake records the folder it was asked to create: the root itself
    expect(provider.folders).toEqual(["root"]);

    const second = await service.callTool(agentC, {
      tool: "cloud_upload",
      root: "personal",
      path: "note.txt",
      contentBase64: Buffer.from("hi").toString("base64"),
    });
    expect(second.ok).toBe(true);
    // the folder is made once: the second call reuses the root it already has
    expect(provider.folders).toEqual(["root"]);
    const personal = (await service.listRoots("onedrive")).filter((root) => root.personalForAgentId === "agent-c");
    expect(personal).toHaveLength(1);
    // and the journal names the folder the call actually landed in
    const journal = await service.journal();
    expect(journal[0]).toMatchObject({ actor: "agent-c", tool: "cloud_upload", rootName: personal[0]?.name });
  });

  it("keeps one agent out of another agent's own folder", async () => {
    const { service } = build();
    await seed(service);
    await service.callTool(agentC, { tool: "cloud_list", root: "personal", path: "" });

    const other = await service.callTool(agentBInCompany, { tool: "cloud_list", root: "personal", path: "" });
    expect(other.ok).toBe(true);
    const roots = await service.listRoots("onedrive");
    const personal = roots.filter((root) => root.personalForAgentId !== null);
    expect(personal.map((root) => root.personalForAgentId).sort()).toEqual(["agent-b", "agent-c"]);
    const agentBAccess = await service.accessFor({ agentId: "agent-b", caste: null });
    expect(agentBAccess.filter((entry) => entry.root.personalForAgentId === "agent-c")).toHaveLength(0);
  });

  it("refuses the reserved name with a reason the agent can act on", async () => {
    const { service } = build({ providers: [new FakeProvider("google-drive", "Google Drive")] });
    const noAccount = await service.callTool(agentC, { tool: "cloud_list", root: "personal", path: "" });
    expect(noAccount.ok).toBe(false);
    expect(noAccount.error).toMatch(/no cloud account is connected/);

    await seed(service);
    await service.connectAccount(
      { providerId: "google-drive", displayName: "Owner Drive", companyId: "company-a", tokenRef: "secret/drive" },
      "board",
    );
    const ambiguous = await service.callTool(agentC, { tool: "cloud_list", root: "personal", path: "" });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/ambiguous/);

    const unknownCompany = await service.callTool({ agentId: "agent-c", caste: null }, { tool: "cloud_list", root: "personal", path: "" });
    expect(unknownCompany.ok).toBe(false);
    expect(unknownCompany.error).toMatch(/company this agent works for/);
  });

  it("keeps the reserved name out of the owner's hands", async () => {
    const { service } = build();
    await expect(
      service.createRoot({ providerId: "onedrive", companyId: "company-a", name: "personal", kind: "own", folder: "Shared" }, "board"),
    ).rejects.toThrow(/reserved/);
  });

  it("reads the agent's board role as the caste grants match on", async () => {
    const roles: Record<string, string> = { "agent-a": "engineers", "agent-b": "   " };
    const { service } = build({ agentRole: async (agentId) => roles[agentId] ?? null });
    expect(await service.agentCaste("agent-a")).toBe("engineers");
    expect(await service.agentCaste("agent-b")).toBeNull();
    expect(await service.agentCaste("nobody")).toBeNull();

    await seed(service);
    const team = await service.createRoot({ providerId: "onedrive", companyId: "company-a", name: "team", kind: "own", folder: "Team" }, "board");
    await service.setGrant({ rootId: team.id, targetKind: "caste", caste: "engineers", mode: "ro" }, "board");

    const allowed = await service.callTool({ agentId: "agent-a", caste: await service.agentCaste("agent-a") }, { tool: "cloud_list", root: "team", path: "" });
    expect(allowed.ok).toBe(true);
    const denied = await service.callTool({ agentId: "agent-b", caste: await service.agentCaste("agent-b") }, { tool: "cloud_list", root: "team", path: "" });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not granted/);
  });
});