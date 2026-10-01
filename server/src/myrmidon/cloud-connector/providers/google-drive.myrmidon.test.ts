// myrmidon(CLOUD-CONNECTOR): Google Drive provider tests.
//
// The provider is the only part that speaks the Drive API. These tests pin the
// addressing (Google has no path addressing, so a path is walked down by name
// from the granted root, and an item id never comes from the caller), the
// shortcut refusal, the search confinement, the overwrite refusal and the
// error mapping — all against a fake fetch, no network and no token.

import { describe, expect, it } from "vitest";
import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError } from "../types.js";
import { GoogleDriveProvider } from "./google-drive.js";

const OWN_ROOT: CloudRoot = {
  id: "root-work",
  providerId: "google-drive",
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
  itemId: "id-shared",
  folder: null,
};

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
}

const FILES: Record<string, FakeFile> = {
  root: { id: "root", name: "My Drive", mimeType: FOLDER },
  "id-agents": { id: "id-agents", name: "Agents", mimeType: FOLDER, parents: ["root"] },
  "id-agent-a": { id: "id-agent-a", name: "agent-a", mimeType: FOLDER, parents: ["id-agents"] },
  "id-shared": { id: "id-shared", name: "shared", mimeType: FOLDER, parents: ["root"] },
  "id-notes": {
    id: "id-notes",
    name: "notes.txt",
    mimeType: "text/plain",
    size: "3",
    modifiedTime: "2026-01-01T00:00:00.000Z",
    parents: ["id-agent-a"],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface FakeDriveOptions {
  files?: Record<string, FakeFile>;
  token?: string | null;
  media?: Record<string, string>;
  status?: Record<string, number>;
}

function provider(options: FakeDriveOptions = {}) {
  const files = options.files ?? FILES;
  const token = options.token === undefined ? "token-a" : options.token;
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const raw = init.body as BodyInit | null | undefined;
    const body =
      typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : undefined;
    calls.push({ method, url, body });
    const parsed = new URL(url, "https://www.googleapis.com");
    const forced = options.status?.[`${method} ${parsed.pathname}`];
    if (forced) return json({ error: { message: `forced ${forced}` } }, forced);

    // media download
    if (parsed.searchParams.get("alt") === "media") {
      const id = parsed.pathname.split("/").pop() ?? "";
      const content = (options.media ?? { "id-notes": "hi!" })[id];
      return content === undefined ? json({}, 404) : new Response(content, { status: 200 });
    }
    // resumable upload session
    if (parsed.pathname.endsWith("/upload/drive/v3/files") && parsed.searchParams.get("uploadType") === "resumable") {
      return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
    }
    // content update of an existing file
    if (parsed.pathname.startsWith("/upload/drive/v3/files/")) {
      const id = parsed.pathname.split("/").pop() ?? "";
      return json(files[id] ?? { id, name: "file" });
    }
    // multipart upload
    if (parsed.pathname.endsWith("/upload/drive/v3/files")) {
      const name = /"name":"([^"]+)"/.exec(body ?? "")?.[1] ?? "file";
      return json({ id: "id-new", name, mimeType: "text/plain", parents: ["id-agent-a"] }, 200);
    }
    // metadata create (a folder, usually)
    if (parsed.pathname.endsWith("/files") && method === "POST") {
      const meta = JSON.parse(body ?? "{}") as { name?: string; mimeType?: string; parents?: string[] };
      return json({ id: `id-${meta.name ?? "new"}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents }, 200);
    }
    // collection
    if (parsed.pathname.endsWith("/files")) {
      const query = parsed.searchParams.get("q") ?? "";
      if (query.startsWith("name contains")) {
        return json({ files: Object.values(files).filter((file) => (file.name ?? "").includes("inside")) });
      }
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      return json({ files: Object.values(files).filter((file) => (file.parents ?? []).includes(parent ?? "")) });
    }
    // single file
    const id = parsed.pathname.split("/").pop() ?? "";
    const file = files[id];
    if (!file) return json({ error: { message: `File not found: ${id}` } }, 404);
    if (method === "PATCH") return json({ ...file, name: "renamed.txt", parents: ["id-agent-a"] });
    return json(file);
  }) as unknown as typeof fetch;
  return {
    provider: new GoogleDriveProvider({ accessToken: async () => token, fetchImpl: fake }),
    calls,
  };
}

describe("GoogleDriveProvider", () => {
  it("refuses to work before the account is connected", async () => {
    const { provider: subject } = provider({ token: null });
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toThrow(/not connected/);
  });

  it("walks an own root down its folder path instead of trusting an id", async () => {
    const { provider: subject, calls } = provider();
    const listing = await subject.list({ root: OWN_ROOT, parts: [] }, 10);
    expect(listing.items.map((item) => item.name)).toEqual(["notes.txt"]);
    expect(calls[0].url).toContain("/files/root?fields=");
    expect(calls.some((call) => decodeURIComponent(call.url).includes("'id-agents' in parents"))).toBe(true);
    expect(calls.some((call) => decodeURIComponent(call.url).includes("'id-agent-a' in parents"))).toBe(true);
  });

  it("addresses a shared root by its drive and item", async () => {
    const { provider: subject, calls } = provider();
    await subject.list({ root: SHARED_ROOT, parts: [] }, 10);
    expect(calls[0].url).toContain("/files/id-shared?fields=");
    expect(calls[0].url).toContain("driveId=drive-x");
    expect(calls.some((call) => call.url.includes("supportsAllDrives=true"))).toBe(true);
  });

  it("refuses a shortcut to another location", async () => {
    const files = { ...FILES, "id-agent-a": { ...FILES["id-agent-a"], mimeType: SHORTCUT } };
    const { provider: subject } = provider({ files });
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({ status: 400 });
  });

  it("maps an authorization failure to a refusal the caller can act on", async () => {
    const { provider: subject } = provider({ status: { "GET /drive/v3/files/root": 401 } });
    await expect(subject.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({
      status: 403,
      message: "forced 401",
    });
  });

  it("keeps a missing path as not found and a broken provider as a bad gateway", async () => {
    const missing = provider({ files: { root: FILES.root } });
    await expect(missing.provider.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({ status: 404 });

    const broken = provider({ status: { "GET /drive/v3/files/root": 500 } });
    await expect(broken.provider.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toMatchObject({ status: 502 });
    await expect(broken.provider.list({ root: OWN_ROOT, parts: [] }, 10)).rejects.toBeInstanceOf(CloudConnectorError);
  });

  it("refuses a Google-native document instead of returning nothing", async () => {
    const files = {
      ...FILES,
      "id-notes": { ...FILES["id-notes"], mimeType: "application/vnd.google-apps.document", size: undefined },
    };
    const { provider: subject } = provider({ files });
    await expect(subject.readBytes({ root: OWN_ROOT, parts: ["notes.txt"] }, 200_000)).rejects.toThrow(/Google-native/);
  });

  it("refuses a file larger than the read limit instead of streaming it", async () => {
    const files = { ...FILES, "id-notes": { ...FILES["id-notes"], size: "5000000" } };
    const { provider: subject } = provider({ files });
    await expect(subject.readBytes({ root: OWN_ROOT, parts: ["notes.txt"] }, 200_000)).rejects.toThrow(/use download/);
  });

  it("reads a file through the media endpoint", async () => {
    const { provider: subject } = provider();
    const read = await subject.readBytes({ root: OWN_ROOT, parts: ["notes.txt"] }, 200_000);
    expect(new TextDecoder().decode(read.content)).toBe("hi!");
    expect(read.item).toMatchObject({ name: "notes.txt", type: "file", size: 3 });
  });

  it("drops search hits that are not provably inside the root", async () => {
    const files = {
      ...FILES,
      "id-inside": { id: "id-inside", name: "inside.txt", mimeType: "text/plain", size: "1", parents: ["id-agent-a"] },
      "id-outside": { id: "id-outside", name: "outside-inside.txt", mimeType: "text/plain", size: "1", parents: ["id-other"] },
      "id-other": { id: "id-other", name: "Elsewhere", mimeType: FOLDER, parents: ["root"] },
    };
    const { provider: subject } = provider({ files });
    const hits = await subject.search({ root: OWN_ROOT, parts: [] }, "inside", 20);
    expect(hits.map((hit) => hit.path)).toEqual(["inside.txt"]);
  });

  it("creates a file with a multipart upload when the name is free", async () => {
    const { provider: subject, calls } = provider();
    const uploaded = await subject.upload({ root: OWN_ROOT, parts: ["fresh.txt"] }, new TextEncoder().encode("hi!"), false);
    expect(uploaded.name).toBe("fresh.txt");
    expect(calls.some((call) => call.method === "POST" && call.url.includes("uploadType=multipart"))).toBe(true);
  });

  it("refuses to overwrite when overwrite is off, and replaces content when it is on", async () => {
    const off = provider();
    await expect(off.provider.upload({ root: OWN_ROOT, parts: ["notes.txt"] }, new Uint8Array([1]), false)).rejects.toMatchObject({
      status: 409,
    });
    expect(off.calls.some((call) => call.url.includes("uploadType=multipart"))).toBe(false);

    const on = provider();
    const replaced = await on.provider.upload({ root: OWN_ROOT, parts: ["notes.txt"] }, new Uint8Array([1]), true);
    expect(replaced.name).toBe("notes.txt");
    expect(on.calls.some((call) => call.method === "PATCH" && call.url.includes("uploadType=media"))).toBe(true);
  });

  it("renames and re-parents on move", async () => {
    const { provider: subject, calls } = provider();
    const moved = await subject.move({ root: OWN_ROOT, parts: ["notes.txt"] }, { root: OWN_ROOT, parts: ["renamed.txt"] });
    expect(moved.name).toBe("renamed.txt");
    const patch = calls.find((call) => call.method === "PATCH" && call.url.includes("addParents"));
    expect(patch?.url).toContain("removeParents=id-agent-a");
  });

  it("creates the folder chain a write needs", async () => {
    const { provider: subject, calls } = provider();
    const folder = await subject.ensureFolder({ root: OWN_ROOT, parts: ["sub"] });
    expect(folder).toMatchObject({ name: "sub", type: "folder" });
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/files?fields="))).toBe(true);
  });
});