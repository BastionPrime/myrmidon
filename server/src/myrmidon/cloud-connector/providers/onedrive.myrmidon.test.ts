// myrmidon(CLOUD-CONNECTOR): OneDrive provider tests.
//
// The provider is the only part that speaks Microsoft Graph. These tests pin
// the addressing (a path is always resolved under the root, never by an item
// id from the caller), the shortcut refusal, the error mapping and the search
// confinement, all against a fake fetch — no network and no token.

import { describe, expect, it } from "vitest";
import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError } from "../types.js";
import { OneDriveProvider } from "./onedrive.js";

const OWN_ROOT: CloudRoot = {
  id: "root-work",
  providerId: "onedrive",
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

const SHARED_ROOT: CloudRoot = {
  ...OWN_ROOT,
  id: "root-shared",
  name: "shared",
  kind: "shared",
  driveId: "drive-x",
  itemId: "item-y",
  folder: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const folderItem = { id: "i1", name: "agent-a", folder: { childCount: 1 }, parentReference: { driveId: "d1", id: "p1" } };
const fileItem = { id: "f1", name: "a.txt", size: 3, file: {}, lastModifiedDateTime: "2026-01-01T00:00:00Z", parentReference: { driveId: "d1", id: "i1" } };

function provider(handler: (url: string, init: RequestInit) => Response | Promise<Response>, token: string | null = "token-a") {
  const calls: string[] = [];
  const fake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? "GET"} ${url}`);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { provider: new OneDriveProvider({ accessToken: async () => token, fetchImpl: fake }), calls };
}

describe("OneDriveProvider", () => {
  it("refuses to work before the account is connected", async () => {
    const { provider: subject } = provider(() => json(folderItem), null);
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toThrow(/not connected/);
  });

  it("addresses an own root by its folder path", async () => {
    const { provider: subject, calls } = provider((url) => {
      if (url.includes("/children")) return json({ value: [fileItem] });
      return json(folderItem);
    });
    const listing = await subject.list({ root: OWN_ROOT, parts: [] }, 10);
    expect(listing.items[0]).toMatchObject({ name: "a.txt", type: "file", size: 3 });
    expect(calls[0]).toContain("/me/drive/root:/Agents/agent-a:");
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("addresses a shared root by drive and item", async () => {
    const { provider: subject, calls } = provider((url) => {
      if (url.includes("/children")) return json({ value: [fileItem] });
      return json({ ...folderItem, parentReference: { driveId: "drive-x", id: "item-y" } });
    });
    await subject.list({ root: SHARED_ROOT, parts: ["sub"] }, 10);
    expect(calls[0]).toContain("/drives/drive-x/items/item-y:/sub:");
  });

  it("refuses a shortcut to another location", async () => {
    const { provider: subject } = provider(() => json({ ...folderItem, remoteItem: {} }));
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({ status: 400 });
  });

  it("maps an authorization failure to a refusal the caller can act on", async () => {
    const { provider: subject } = provider(() => json({ error: { message: "InvalidAuthenticationToken" } }, 401));
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({
      status: 403,
      message: "InvalidAuthenticationToken",
    });
  });

  it("refuses a file larger than the read limit instead of streaming it", async () => {
    const { provider: subject } = provider(() => json({ ...fileItem, size: 5_000_000 }));
    await expect(subject.readBytes({ root: OWN_ROOT, parts: ["a.txt"] }, 200_000)).rejects.toThrow(/use download/);
  });

  it("drops search hits that are not provably inside the root", async () => {
    const inside = { ...fileItem, id: "f2", name: "inside.txt", parentReference: { driveId: "d1", id: "i1", path: "/drive/root:/Agents/agent-a" } };
    const outside = { ...fileItem, id: "f3", name: "outside.txt", parentReference: { driveId: "d1", id: "p9", path: "/drive/root:/Elsewhere" } };
    const { provider: subject } = provider((url) => {
      if (url.includes("/search(")) return json({ value: [inside, outside] });
      return json(folderItem);
    });
    const hits = await subject.search({ root: OWN_ROOT, parts: [] }, "txt", 20);
    expect(hits.map((hit) => hit.path)).toEqual(["inside.txt"]);
  });

  it("uploads a small file with a simple PUT", async () => {
    const { provider: subject, calls } = provider((url, init) => {
      if (url.includes("/content") && init.method === "PUT") return json({ ...fileItem, name: "notes.txt" }, 201);
      return json(folderItem);
    });
    const uploaded = await subject.upload({ root: OWN_ROOT, parts: ["notes.txt"] }, new TextEncoder().encode("hi!"), false);
    expect(uploaded.name).toBe("notes.txt");
    expect(calls.some((call) => call.startsWith("PUT") && call.includes("conflictBehavior=fail"))).toBe(true);
  });

  it("reports an existing file when overwrite is off", async () => {
    const { provider: subject } = provider((url, init) => {
      if (url.includes("/content") && init.method === "PUT") return json({}, 409);
      return json(folderItem);
    });
    await expect(subject.upload({ root: OWN_ROOT, parts: ["notes.txt"] }, new Uint8Array([1, 2, 3]), false)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("OneDriveProvider error mapping", () => {
  it("keeps a not-found as not-found", async () => {
    const { provider: subject } = provider(() => json({}, 404));
    await expect(subject.list({ root: OWN_ROOT, parts: ["a.txt"] }, 10)).rejects.toMatchObject({ status: 404 });
  });

  it("reports a server failure as a bad gateway", async () => {
    const { provider: subject } = provider(() => json({}, 500));
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({ status: 502 });
  });

  it("never leaks a raw provider error type", async () => {
    const { provider: subject } = provider(() => json({}, 500));
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toBeInstanceOf(CloudConnectorError);
  });
});