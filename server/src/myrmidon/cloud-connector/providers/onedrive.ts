// myrmidon(CLOUD-CONNECTOR): the OneDrive provider (Microsoft Graph).
//
// Ported from the temporary `cloud-files` service so the board accepts the
// same paths and rejects the same tricks: a path is always relative to a
// root, item ids never come from the caller, `..` and OneDrive shortcuts are
// refused, and a search hit is only returned when it is verifiably inside the
// root. The access token comes from the connector's own secret store, never
// from a bot.

import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError, type CloudItem, type CloudListing } from "../types.js";
import { normalizeCloudName, joinCloudPath } from "../paths.js";
import type { CloudLocation, CloudProvider, CloudSearchHit } from "./provider.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,folder,file,remoteItem,package,parentReference,lastModifiedDateTime";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 32; // 10 MiB, a multiple of 320 KiB as Graph requires
const MAX_WALK_DEPTH = 24;

export interface OneDriveProviderDeps {
  /** Resolves the connector account's access token; null when the account is not connected. */
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  folder?: { childCount?: number };
  file?: unknown;
  remoteItem?: unknown;
  parentReference?: { driveId?: string; id?: string; path?: string };
  lastModifiedDateTime?: string;
}

function encodeSegments(parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function describe(item: GraphItem): CloudItem {
  const isFolder = item.folder !== undefined;
  return {
    name: item.name ?? "",
    type: isFolder ? "folder" : "file",
    size: isFolder ? null : (item.size ?? 0),
    modified: item.lastModifiedDateTime ? item.lastModifiedDateTime.slice(0, 19) : null,
    children: isFolder ? (item.folder?.childCount ?? null) : null,
  };
}

export class OneDriveProvider implements CloudProvider {
  readonly id = "onedrive" as const;
  readonly displayName = "OneDrive";

  constructor(private readonly deps: OneDriveProviderDeps) {}

  private async token(): Promise<string> {
    const token = await this.deps.accessToken();
    if (!token) {
      throw new CloudConnectorError(409, "the OneDrive account is not connected; the owner must connect it first");
    }
    return token;
  }

  private async graph(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const response = await fetchImpl(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      ...init,
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(init.headers ?? {}),
      },
    });
    return response;
  }

  private async json(method: string, path: string, init: RequestInit = {}, ok = [200]): Promise<GraphItem & { value?: GraphItem[]; "@odata.nextLink"?: string; uploadUrl?: string }> {
    const response = await this.graph(method, path, init);
    if (!ok.includes(response.status)) throw await this.error(response);
    return (await response.json()) as GraphItem & { value?: GraphItem[]; "@odata.nextLink"?: string; uploadUrl?: string };
  }

  private async error(response: Response): Promise<CloudConnectorError> {
    const status = response.status;
    const mapped = status === 404 ? 404 : status === 401 || status === 403 ? 403 : status === 409 ? 409 : 502;
    let message = `the cloud provider refused the request (HTTP ${status})`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    return new CloudConnectorError(mapped as 403 | 404 | 409 | 502, message);
  }

  // -- addressing ----------------------------------------------------------

  private base(root: CloudRoot, parts: readonly string[]): string {
    if (root.kind === "shared") {
      const anchor = `/drives/${encodeURIComponent(root.driveId ?? "")}/items/${encodeURIComponent(root.itemId ?? "")}`;
      return parts.length > 0 ? `${anchor}:/${encodeSegments(parts)}:` : anchor;
    }
    const full = [...(root.folder ?? "").split("/").filter((part) => part.length > 0), ...parts];
    return `/me/drive/root:/${encodeSegments(full)}:`;
  }

  private static ref(item: GraphItem): string {
    const driveId = item.parentReference?.driveId;
    if (!driveId || !item.id) throw new CloudConnectorError(502, "the cloud item has no drive reference");
    return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}`;
  }

  private static rejectShortcut(item: GraphItem): void {
    if (item.remoteItem !== undefined) {
      throw new CloudConnectorError(400, "this entry is a shortcut to another location; shortcuts are not followed");
    }
  }

  private async children(ref: string, limit: number): Promise<GraphItem[]> {
    const out: GraphItem[] = [];
    let url: string | null = `${ref}/children?$top=${Math.min(limit, 200)}&$select=${SELECT}`;
    while (url && out.length < limit) {
      const page = await this.json("GET", url, {}, [200]);
      out.push(...(page.value ?? []));
      url = page["@odata.nextLink"] ?? null;
    }
    return out;
  }

  /** The item at (root, parts); a 404 falls back to a normalised name walk. */
  private async item(location: CloudLocation): Promise<GraphItem> {
    const { root, parts } = location;
    const direct = await this.graph("GET", `${this.base(root, parts)}?$select=${SELECT}`);
    if (direct.status === 200) {
      const item = (await direct.json()) as GraphItem;
      OneDriveProvider.rejectShortcut(item);
      return item;
    }
    if (direct.status !== 404 || parts.length === 0) throw await this.error(direct);
    const rootResponse = await this.graph("GET", `${this.base(root, [])}?$select=${SELECT}`);
    if (rootResponse.status !== 200) throw await this.error(rootResponse);
    let current = (await rootResponse.json()) as GraphItem;
    for (const segment of parts) {
      if (current.folder === undefined) throw new CloudConnectorError(404, "not found");
      const hit = (await this.children(OneDriveProvider.ref(current), 2000)).find(
        (candidate) => normalizeCloudName(candidate.name ?? "") === normalizeCloudName(segment),
      );
      if (!hit) throw new CloudConnectorError(404, "not found");
      OneDriveProvider.rejectShortcut(hit);
      current = hit;
    }
    return current;
  }

  // -- reads ----------------------------------------------------------------

  async list(location: CloudLocation, limit: number): Promise<CloudListing> {
    const item = await this.item(location);
    if (item.folder === undefined) throw new CloudConnectorError(400, "not a folder");
    const kids = await this.children(OneDriveProvider.ref(item), limit + 1);
    return { path: joinCloudPath(location.parts), items: kids.slice(0, limit).map(describe), truncated: kids.length > limit };
  }

  async search(location: CloudLocation, query: string, limit: number): Promise<CloudSearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 200 || /['"\\\n\r]/.test(trimmed)) {
      throw new CloudConnectorError(400, "query: 1-200 characters, no quotes or backslashes");
    }
    const item = await this.item(location);
    const found = await this.json("GET", `${OneDriveProvider.ref(item)}/search(q='${encodeURIComponent(trimmed)}')?$top=${limit}&$select=${SELECT}`, {}, [200]);
    const out: CloudSearchHit[] = [];
    for (const hit of (found.value ?? []).slice(0, limit)) {
      const path = await this.pathInRoot(location.root, hit, new Map());
      if (path === null) continue; // not verifiably inside the root: never shown
      out.push({ path: joinCloudPath(path), item: describe(hit) });
    }
    return out;
  }

  /** Walk parents up to the root; anything not provably inside it is dropped. */
  private async pathInRoot(root: CloudRoot, hit: GraphItem, cache: Map<string, GraphItem | null>): Promise<string[] | null> {
    const names = [hit.name ?? ""];
    let current = hit;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
      const parent = current.parentReference ?? {};
      const parentId = parent.id;
      if (root.kind === "shared") {
        if (parentId === root.itemId) return names.slice().reverse();
      } else {
        const path = parent.path ?? "";
        const base = `/drive/root:/${root.folder ?? ""}`;
        if (path === base || path.startsWith(`${base}/`)) {
          if (current !== hit) return null;
          const middle = path.slice(base.length).split("/").filter((segment) => segment.length > 0);
          return [...middle, hit.name ?? ""];
        }
        return null;
      }
      if (!parentId) return null;
      if (cache.has(parentId) && cache.get(parentId) === null) return null;
      if (!cache.has(parentId)) {
        const response = await this.graph("GET", `/drives/${encodeURIComponent(parent.driveId ?? "")}/items/${encodeURIComponent(parentId)}?$select=id,name,parentReference`);
        cache.set(parentId, response.status === 200 ? ((await response.json()) as GraphItem) : null);
      }
      const parentItem = cache.get(parentId) ?? null;
      if (!parentItem) return null;
      names.push(parentItem.name ?? "");
      current = parentItem;
    }
    return null;
  }

  async readBytes(location: CloudLocation, limit: number): Promise<{ item: CloudItem; content: Uint8Array }> {
    const item = await this.item(location);
    if (item.folder !== undefined || item.file === undefined) throw new CloudConnectorError(400, "not a file");
    if ((item.size ?? 0) > limit) {
      throw new CloudConnectorError(400, `file is ${item.size ?? 0} bytes, more than ${limit}; use download`);
    }
    const response = await this.graph("GET", `${OneDriveProvider.ref(item)}/content`, { redirect: "follow" });
    if (response.status !== 200) throw await this.error(response);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new CloudConnectorError(400, "file grew past the limit; use download");
    return { item: describe(item), content: buffer };
  }

  // -- writes (own roots only; the caller has checked rw) -------------------

  async ensureFolder(location: CloudLocation): Promise<CloudItem> {
    const { root, parts } = location;
    try {
      const item = await this.item(location);
      if (item.folder === undefined) throw new CloudConnectorError(400, "a file is in the way of this folder");
      return describe(item);
    } catch (error) {
      if (!(error instanceof CloudConnectorError) || error.status !== 404) throw error;
    }
    if (parts.length === 0) {
      return this.createRootFolder(root);
    }
    const parent = await this.ensureFolder({ root, parts: parts.slice(0, -1) });
    const parentItem = await this.item({ root, parts: parts.slice(0, -1) });
    if (parent.type !== "folder") throw new CloudConnectorError(400, "a file is in the way of this folder");
    const response = await this.graph("POST", `${OneDriveProvider.ref(parentItem)}/children`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: parts[parts.length - 1], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (response.status === 409) return describe(await this.item(location));
    if (response.status !== 200 && response.status !== 201) throw await this.error(response);
    return describe((await response.json()) as GraphItem);
  }

  private async createRootFolder(root: CloudRoot): Promise<CloudItem> {
    const names = (root.folder ?? "").split("/").filter((part) => part.length > 0);
    if (names.length === 0) throw new CloudConnectorError(400, "the root folder has no name");
    let parentRef = "/me/drive/root";
    let last: CloudItem | null = null;
    for (let index = 0; index < names.length; index += 1) {
      const existing = await this.graph("GET", `/me/drive/root:/${encodeSegments(names.slice(0, index + 1))}?$select=${SELECT}`);
      if (existing.status === 200) {
        last = describe((await existing.json()) as GraphItem);
      } else {
        const response = await this.graph("POST", `${parentRef}/children`, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: names[index], folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
        });
        if (response.status !== 200 && response.status !== 201) throw await this.error(response);
        last = describe((await response.json()) as GraphItem);
      }
      parentRef = await this.referenceFor(root, names.slice(0, index + 1));
    }
    if (!last) throw new CloudConnectorError(502, "could not create the root folder");
    return last;
  }

  private async referenceFor(root: CloudRoot, parts: readonly string[]): Promise<string> {
    return OneDriveProvider.ref(await this.item({ root, parts: [...parts] }));
  }

  async upload(location: CloudLocation, content: Uint8Array, overwrite: boolean): Promise<CloudItem> {
    if (location.parts.length === 0) throw new CloudConnectorError(400, "give a file path");
    await this.ensureFolder({ root: location.root, parts: location.parts.slice(0, -1) });
    const behavior = overwrite ? "replace" : "fail";
    const base = this.base(location.root, location.parts);
    if (content.byteLength <= SIMPLE_UPLOAD_MAX) {
      const response = await this.graph("PUT", `${base}/content?@microsoft.graph.conflictBehavior=${behavior}`, {
        headers: { "content-type": "application/octet-stream" },
        body: content as unknown as BodyInit,
      });
      if (response.status === 409) throw new CloudConnectorError(409, "a file with this name already exists (overwrite=false)");
      if (response.status !== 200 && response.status !== 201) throw await this.error(response);
      return describe((await response.json()) as GraphItem);
    }
    return this.uploadInSession(base, content, behavior);
  }

  private async uploadInSession(base: string, content: Uint8Array, behavior: string): Promise<CloudItem> {
    const session = await this.graph("POST", `${base}/createUploadSession`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": behavior } }),
    });
    if (session.status === 409) throw new CloudConnectorError(409, "a file with this name already exists (overwrite=false)");
    if (session.status !== 200) throw await this.error(session);
    const { uploadUrl } = (await session.json()) as { uploadUrl: string };
    let sent = 0;
    let last: Response | null = null;
    while (sent < content.byteLength) {
      const chunk = content.subarray(sent, sent + CHUNK);
      const end = sent + chunk.byteLength - 1;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        last = await (this.deps.fetchImpl ?? fetch)(uploadUrl, {
          method: "PUT",
          headers: { "content-range": `bytes ${sent}-${end}/${content.byteLength}` },
          body: chunk as unknown as BodyInit,
        });
        if (last.status < 500) break;
      }
      if (!last || ![200, 201, 202].includes(last.status)) {
        await (this.deps.fetchImpl ?? fetch)(uploadUrl, { method: "DELETE" });
        throw new CloudConnectorError(502, `upload failed at byte ${sent}`);
      }
      sent += chunk.byteLength;
    }
    if (!last) throw new CloudConnectorError(502, "upload produced no response");
    return describe((await last.json()) as GraphItem);
  }

  async move(source: CloudLocation, destination: CloudLocation): Promise<CloudItem> {
    if (source.parts.length === 0 || destination.parts.length === 0) {
      throw new CloudConnectorError(400, "give the source and destination paths");
    }
    const item = await this.item(source);
    const parent = await this.item({ root: destination.root, parts: destination.parts.slice(0, -1) });
    const response = await this.graph("PATCH", OneDriveProvider.ref(item), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: destination.parts[destination.parts.length - 1],
        parentReference: { id: parent.id },
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    });
    if (response.status === 409) throw new CloudConnectorError(409, "the destination already exists");
    if (response.status !== 200) throw await this.error(response);
    return describe((await response.json()) as GraphItem);
  }
}