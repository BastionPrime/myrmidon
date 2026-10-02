// myrmidon(CLOUD-CONNECTOR): Yandex Disk provider tests.
//
// Yandex addresses by real paths, so these tests pin that an own root is built
// from the owner's folder plus the confined segments, that a shared root is
// refused with a message instead of being approximated, that the account token
// never travels to the storage host (the download and upload links are
// pre-signed), and that search can only return what it walked inside the root.

import { describe, expect, it } from "vitest";
import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError } from "../types.js";
import { YandexDiskProvider } from "./yandex-disk.js";

const OWN_ROOT: CloudRoot = {
  id: "root-work",
  providerId: "yandex-disk",
  companyId: "company-a",
  name: "work",
  kind: "own",
  description: "",
  driveId: null,
  itemId: null,
  folder: "Agents/agent-a",
  personalForAgentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SHARED_ROOT: CloudRoot = { ...OWN_ROOT, kind: "shared", driveId: "drive-x", itemId: "item-y", folder: null };

type Node = { name: string; type: "dir" | "file"; path: string; size?: number; modified?: string };

const TREE: Node[] = [
  { name: "Agents", type: "dir", path: "disk:/Agents" },
  { name: "agent-a", type: "dir", path: "disk:/Agents/agent-a" },
  { name: "notes.txt", type: "file", path: "disk:/Agents/agent-a/notes.txt", size: 3, modified: "2026-01-01T00:00:00+00:00" },
  { name: "sub", type: "dir", path: "disk:/Agents/agent-a/sub" },
  { name: "inside.txt", type: "file", path: "disk:/Agents/agent-a/sub/inside.txt", size: 1 },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function childrenOf(path: string): Node[] {
  return TREE.filter((node) => node.path.startsWith(`${path}/`) && !node.path.slice(path.length + 1).includes("/"));
}

interface FakeOptions {
  token?: string | null;
  status?: Record<string, number>;
  conflictOn?: "upload" | "move" | null;
  pollDelayMs?: number;
}

function provider(options: FakeOptions = {}) {
  const token = options.token === undefined ? "token-a" : options.token;
  const calls: Array<{ method: string; url: string; authorization: string | null; body?: string }> = [];
  const uploaded: string[] = [];
  const fake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      authorization: headers.authorization ?? headers.Authorization ?? null,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const parsed = new URL(url, "https://cloud-api.yandex.net");
    const forced = options.status?.[`${method} ${parsed.pathname}`];
    if (forced) return json({ description: `forced ${forced}` }, forced);

    // pre-signed storage hosts: no API token here
    if (parsed.host === "upload.example") {
      if (options.conflictOn === "upload") return json({ description: "already exists" }, 409);
      const target = parsed.searchParams.get("path") ?? "";
      uploaded.push(target);
      const name = target.split("/").pop() ?? "";
      TREE.push({ name, type: "file", path: target, size: 1 });
      return new Response(null, { status: 201 });
    }
    if (parsed.host === "download.example") return new Response("hi!", { status: 200 });

    if (parsed.pathname === "/v1/disk/resources/upload") {
      const path = parsed.searchParams.get("path") ?? "";
      return json({ href: `https://upload.example/put?path=${encodeURIComponent(path)}`, method: "PUT" });
    }
    if (parsed.pathname === "/v1/disk/resources/download") {
      return json({ href: "https://download.example/get", method: "GET" });
    }
    if (parsed.pathname === "/v1/disk/resources/move") {
      if (options.conflictOn === "move") return json({ description: "already exists" }, 409);
      return new Response(null, { status: 201 });
    }
    if (parsed.pathname === "/v1/disk/resources" && method === "PUT") {
      const path = parsed.searchParams.get("path") ?? "";
      const exists = TREE.some((node) => node.path === path);
      return new Response(null, { status: exists ? 409 : 201 });
    }
    if (parsed.pathname === "/v1/disk/resources") {
      const path = parsed.searchParams.get("path") ?? "";
      const node = TREE.find((entry) => entry.path === path);
      if (!node) return json({ description: "Resource not found", error: "DiskNotFoundError" }, 404);
      const all = childrenOf(path);
      const limitRaw = parsed.searchParams.get("limit");
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const items = limitRaw ? all.slice(offset, offset + Number(limitRaw)) : all;
      return json({ ...node, _embedded: { items, total: all.length } });
    }
    return json({ description: "unexpected call" }, 500);
  }) as unknown as typeof fetch;
  return {
    provider: new YandexDiskProvider({
      accessToken: async () => token,
      fetchImpl: fake,
      pollDelayMs: options.pollDelayMs ?? 0,
    }),
    calls,
    uploaded,
  };
}

describe("YandexDiskProvider", () => {
  it("refuses to work before the account is connected", async () => {
    const { provider: subject } = provider({ token: null });
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toThrow(/not connected/);
  });

  it("builds an own root path from the owner's folder and the confined segments", async () => {
    const { provider: subject, calls } = provider();
    const listing = await subject.list({ root: OWN_ROOT, parts: [] }, 10);
    expect(listing.items.map((item) => item.name)).toEqual(["notes.txt", "sub"]);
    expect(decodeURIComponent(calls[0].url)).toContain("path=disk:/Agents/agent-a");
  });

  it("refuses a shared root instead of approximating it", async () => {
    const { provider: subject } = provider();
    await expect(subject.list({ root: SHARED_ROOT, parts: [] }, 10)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/no shared-folder addressing/),
    });
  });

  it("reports a truncated listing when more entries exist than asked for", async () => {
    const { provider: subject } = provider();
    const listing = await subject.list({ root: OWN_ROOT, parts: [] }, 1);
    expect(listing.items).toHaveLength(1);
    expect(listing.truncated).toBe(true);
  });

  it("reads a file through the pre-signed link without sending the account token to storage", async () => {
    const { provider: subject, calls } = provider();
    const read = await subject.readBytes({ root: OWN_ROOT, parts: ["notes.txt"] }, 200_000);
    expect(new TextDecoder().decode(read.content)).toBe("hi!");
    const storage = calls.find((call) => call.url.startsWith("https://download.example"));
    expect(storage?.authorization).toBeNull();
    expect(calls.find((call) => call.url.includes("resources/download"))?.authorization).toBe("Bearer token-a");
  });

  it("refuses a file larger than the read limit instead of streaming it", async () => {
    const { provider: subject } = provider();
    await expect(subject.readBytes({ root: OWN_ROOT, parts: ["notes.txt"] }, 1)).rejects.toThrow(/use download/);
  });

  it("uploads through the pre-signed link and waits for the item to settle", async () => {
    const { provider: subject, calls, uploaded } = provider();
    const result = await subject.upload({ root: OWN_ROOT, parts: ["sub", "fresh.txt"] }, new TextEncoder().encode("x"), false);
    expect(result).toMatchObject({ name: "fresh.txt", type: "file" });
    expect(uploaded).toEqual(["disk:/Agents/agent-a/sub/fresh.txt"]);
    expect(decodeURIComponent(calls.find((call) => call.url.includes("resources/upload"))!.url)).toContain("overwrite=false");
    expect(calls.find((call) => call.url.startsWith("https://upload.example"))?.authorization).toBeNull();
  });

  it("reports an existing file when overwrite is off", async () => {
    const { provider: subject } = provider({ conflictOn: "upload" });
    await expect(subject.upload({ root: OWN_ROOT, parts: ["notes.txt"] }, new Uint8Array([1]), false)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("reports an existing destination on move", async () => {
    const { provider: subject } = provider({ conflictOn: "move" });
    await expect(
      subject.move({ root: OWN_ROOT, parts: ["notes.txt"] }, { root: OWN_ROOT, parts: ["sub", "notes.txt"] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("creates the folder chain a write needs and accepts an existing folder", async () => {
    const { provider: subject, calls } = provider();
    const folder = await subject.ensureFolder({ root: OWN_ROOT, parts: ["sub"] });
    expect(folder.type).toBe("folder");
    expect(calls.filter((call) => call.method === "PUT" && call.url.includes("/v1/disk/resources"))).not.toHaveLength(0);
  });

  it("searches only inside the granted root and returns root-relative paths", async () => {
    const { provider: subject } = provider();
    const hits = await subject.search({ root: OWN_ROOT, parts: [] }, "inside", 20);
    expect(hits.map((hit) => hit.path)).toEqual(["sub/inside.txt"]);
    expect(hits[0].item.type).toBe("file");
  });

  it("keeps a missing path as not found and a broken provider as a bad gateway", async () => {
    const missing = provider();
    await expect(missing.provider.list({ root: OWN_ROOT, parts: ["nope"] }, 10)).rejects.toMatchObject({ status: 404 });

    const broken = provider({ status: { "GET /v1/disk/resources": 500 } });
    await expect(broken.provider.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({ status: 502 });
    await expect(broken.provider.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toBeInstanceOf(CloudConnectorError);
  });
});