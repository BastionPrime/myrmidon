// myrmidon(CLOUD-CONNECTOR): the Google Drive provider (Drive API v3).
//
// Same contract as the OneDrive provider: a path is resolved strictly under
// the granted root, an item id never comes from the caller, shortcuts are
// refused, and a search hit is only returned when its parent chain provably
// reaches the root. Google has no path addressing — every folder is a file id
// — so an own root is walked down from "root" by the folder path the owner
// recorded, and a shared root starts at the drive+item pair.

import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError, type CloudItem, type CloudListing } from "../types.js";
import { normalizeCloudName, joinCloudPath } from "../paths.js";
import type { CloudLocation, CloudProvider, CloudSearchHit } from "./provider.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
const FIELDS = "id,name,mimeType,size,modifiedTime,parents";
const MAX_WALK_DEPTH = 24;
const SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024;
const UPLOAD_CHUNK = 8 * 1024 * 1024;

export interface GoogleDriveProviderDeps {
  /** Resolves the access token of the account that owns this root; null when not connected. */
  accessToken: (root: CloudRoot) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
}

interface DriveList {
  files?: DriveFile[];
  nextPageToken?: string;
}

function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME;
}

function isNative(file: DriveFile): boolean {
  return (file.mimeType ?? "").startsWith(NATIVE_MIME_PREFIX) && file.mimeType !== FOLDER_MIME;
}

function describe(file: DriveFile): CloudItem {
  const folder = isFolder(file);
  const size = file.size === undefined ? null : Number(file.size);
  return {
    name: file.name ?? "",
    type: folder ? "folder" : "file",
    size: folder ? null : (Number.isFinite(size) ? size : null),
    modified: file.modifiedTime ? file.modifiedTime.slice(0, 19) : null,
    children: null,
  };
}

export class GoogleDriveProvider implements CloudProvider {
  readonly id = "google-drive" as const;
  readonly displayName = "Google Drive";

  constructor(private readonly deps: GoogleDriveProviderDeps) {}

  private async token(root: CloudRoot): Promise<string> {
    const token = await this.deps.accessToken(root);
    if (!token) {
      throw new CloudConnectorError(409, "the Google Drive account is not connected; the owner must connect it first");
    }
    return token;
  }

  private async request(root: CloudRoot, method: string, url: string, init: RequestInit = {}): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return fetchImpl(url.startsWith("http") ? url : `${API}${url}`, {
      ...init,
      method,
      headers: {
        authorization: `Bearer ${await this.token(root)}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async json<T>(root: CloudRoot, method: string, url: string, init: RequestInit = {}, ok = [200]): Promise<T> {
    const response = await this.request(root, method, url, init);
    if (!ok.includes(response.status)) throw await this.error(response);
    return (await response.json()) as T;
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

  /** Params every call carries so a root that lives in a shared drive is reachable. */
  private scoping(root: CloudRoot): string {
    const shared = root.kind === "shared" && root.driveId ? `&driveId=${encodeURIComponent(root.driveId)}` : "";
    return `&supportsAllDrives=true&includeItemsFromAllDrives=true${shared}`;
  }

  private static ownSegments(root: CloudRoot): string[] {
    if (root.kind === "shared") return [];
    return (root.folder ?? "").split("/").filter((part) => part.length > 0);
  }

  /** The id the granted root starts at: the shared item, or the account's My Drive root. */
  private anchorId(root: CloudRoot): string {
    if (root.kind === "shared") {
      if (!root.itemId) throw new CloudConnectorError(400, "the shared folder has no id");
      return root.itemId;
    }
    return "root";
  }

  private static rejectShortcut(file: DriveFile): void {
    if (file.mimeType === SHORTCUT_MIME) {
      throw new CloudConnectorError(400, "this entry is a shortcut to another location; shortcuts are not followed");
    }
  }

  // -- addressing ----------------------------------------------------------

  private async getFile(root: CloudRoot, id: string): Promise<DriveFile> {
    const file = await this.json<DriveFile>(root, "GET", `/files/${encodeURIComponent(id)}?fields=${FIELDS}${this.scoping(root)}`);
    GoogleDriveProvider.rejectShortcut(file);
    return file;
  }

  private async children(root: CloudRoot, parentId: string, limit: number): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    const query = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    let pageToken: string | undefined;
    do {
      const page = await this.json<DriveList>(
        root,
        "GET",
        `/files?q=${query}&fields=${encodeURIComponent(`files(${FIELDS}),nextPageToken`)}`
        + `&pageSize=${Math.min(Math.max(limit, 1), 1000)}&orderBy=folder,name${this.scoping(root)}`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      );
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < limit);
    return out.slice(0, limit);
  }

  private async childByName(root: CloudRoot, parentId: string, name: string): Promise<DriveFile | null> {
    const kids = await this.children(root, parentId, 1000);
    const hit = kids.find((candidate) => normalizeCloudName(candidate.name ?? "") === normalizeCloudName(name));
    if (hit) GoogleDriveProvider.rejectShortcut(hit);
    return hit ?? null;
  }

  private async createFolder(root: CloudRoot, parentId: string, name: string): Promise<DriveFile> {
    const response = await this.request(root, "POST", `/files?fields=${FIELDS}${this.scoping(root)}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (response.status === 409) {
      const existing = await this.childByName(root, parentId, name);
      if (existing) return existing;
    }
    if (response.status !== 200 && response.status !== 201) throw await this.error(response);
    return (await response.json()) as DriveFile;
  }

  /** Walk the root's own path plus `parts` from the anchor, creating nothing. Resolves files too. */
  private async resolveItem(location: CloudLocation): Promise<DriveFile> {
    const { root, parts } = location;
    let current = await this.getFile(root, this.anchorId(root));
    for (const segment of [...GoogleDriveProvider.ownSegments(root), ...parts]) {
      if (!isFolder(current)) throw new CloudConnectorError(404, "not found");
      const child = await this.childByName(root, current.id ?? "", segment);
      if (!child) throw new CloudConnectorError(404, "not found");
      current = child;
    }
    return current;
  }

  /** Same walk, but a missing segment is created. */
  private async ensureChain(root: CloudRoot, segments: readonly string[]): Promise<DriveFile> {
    let current = await this.getFile(root, this.anchorId(root));
    for (const segment of segments) {
      if (!isFolder(current)) throw new CloudConnectorError(400, "a file is in the way of this folder");
      const child = await this.childByName(root, current.id ?? "", segment);
      current = child ?? (await this.createFolder(root, current.id ?? "", segment));
    }
    return current;
  }

  // -- reads ---------------------------------------------------------------

  async list(location: CloudLocation, limit: number): Promise<CloudListing> {
    const folder = await this.resolveItem(location);
    if (!isFolder(folder)) throw new CloudConnectorError(400, "not a folder");
    const kids = await this.children(location.root, folder.id ?? "", Math.max(limit + 1, 2));
    return {
      path: joinCloudPath(location.parts),
      items: kids.slice(0, limit).map(describe),
      truncated: kids.length > limit,
    };
  }

  async search(location: CloudLocation, query: string, limit: number): Promise<CloudSearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 200 || /['"\\\n\r]/.test(trimmed)) {
      throw new CloudConnectorError(400, "query: 1-200 characters, no quotes or backslashes");
    }
    const folder = await this.resolveItem(location);
    const anchorId = folder.id ?? "";
    const found = await this.json<DriveList>(
      location.root,
      "GET",
      `/files?q=${encodeURIComponent(`name contains '${trimmed}' and trashed=false`)}`
      + `&fields=${encodeURIComponent(`files(${FIELDS}),nextPageToken`)}&pageSize=${Math.min(Math.max(limit, 1), 1000)}`
      + this.scoping(location.root),
    );
    const cache = new Map<string, DriveFile | null>();
    const out: CloudSearchHit[] = [];
    for (const hit of (found.files ?? []).slice(0, limit)) {
      const path = await this.pathInRoot(location.root, anchorId, hit, cache);
      if (path === null) continue; // not verifiably inside the root: never shown
      out.push({ path: joinCloudPath(path), item: describe(hit) });
    }
    return out;
  }

  /** Walk parents up to the root; anything not provably inside it is dropped. */
  private async pathInRoot(
    root: CloudRoot,
    anchorId: string,
    hit: DriveFile,
    cache: Map<string, DriveFile | null>,
  ): Promise<string[] | null> {
    const names = [hit.name ?? ""];
    let current = hit;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
      const parentId = current.parents?.[0];
      if (!parentId) return null;
      if (parentId === anchorId) return names.reverse();
      if (!cache.has(parentId)) {
        const response = await this.request(root, "GET", `/files/${encodeURIComponent(parentId)}?fields=${FIELDS}${this.scoping(root)}`);
        cache.set(parentId, response.status === 200 ? ((await response.json()) as DriveFile) : null);
      }
      const parent = cache.get(parentId) ?? null;
      if (!parent) return null;
      names.push(parent.name ?? "");
      current = parent;
    }
    return null;
  }

  async readBytes(location: CloudLocation, limit: number): Promise<{ item: CloudItem; content: Uint8Array }> {
    const file = await this.resolveItem(location);
    if (isFolder(file)) throw new CloudConnectorError(400, "not a file");
    if (isNative(file)) {
      throw new CloudConnectorError(400, `${file.name ?? "this file"} is a Google-native document; download an exported copy instead`);
    }
    const size = file.size === undefined ? null : Number(file.size);
    if (size !== null && size > limit) {
      throw new CloudConnectorError(400, `file is ${size} bytes, more than ${limit}; use download`);
    }
    const response = await this.request(location.root, "GET", `/files/${encodeURIComponent(file.id ?? "")}?alt=media${this.scoping(location.root)}`);
    if (response.status !== 200) throw await this.error(response);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new CloudConnectorError(400, "file grew past the limit; use download");
    return { item: describe(file), content: buffer };
  }

  // -- writes (own roots only; the caller has checked rw) ------------------

  async ensureFolder(location: CloudLocation): Promise<CloudItem> {
    const folder = await this.ensureChain(location.root, [
      ...GoogleDriveProvider.ownSegments(location.root),
      ...location.parts,
    ]);
    if (!isFolder(folder)) throw new CloudConnectorError(400, "a file is in the way of this folder");
    return describe(folder);
  }

  async upload(location: CloudLocation, content: Uint8Array, overwrite: boolean): Promise<CloudItem> {
    if (location.parts.length === 0) throw new CloudConnectorError(400, "give a file path");
    const name = location.parts[location.parts.length - 1];
    const parent = await this.ensureChain(location.root, [
      ...GoogleDriveProvider.ownSegments(location.root),
      ...location.parts.slice(0, -1),
    ]);
    if (!isFolder(parent)) throw new CloudConnectorError(400, "a file is in the way of this folder");
    const parentId = parent.id ?? "";
    const existing = await this.childByName(location.root, parentId, name);
    if (existing && !overwrite) {
      throw new CloudConnectorError(409, "a file with this name already exists (overwrite=false)");
    }
    if (existing) return this.replaceContent(location.root, existing.id ?? "", content);
    if (content.byteLength > SIMPLE_UPLOAD_MAX) {
      return this.uploadResumable(location.root, parentId, name, content);
    }
    return this.uploadMultipart(location.root, parentId, name, content);
  }

  private async replaceContent(root: CloudRoot, fileId: string, content: Uint8Array): Promise<CloudItem> {
    const response = await (this.deps.fetchImpl ?? fetch)(
      `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${FIELDS}${this.scoping(root)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${await this.token(root)}`, "content-type": "application/octet-stream" },
        body: content as unknown as BodyInit,
      },
    );
    if (response.status !== 200) throw await this.error(response);
    return describe((await response.json()) as DriveFile);
  }

  private async uploadMultipart(root: CloudRoot, parentId: string, name: string, content: Uint8Array): Promise<CloudItem> {
    const boundary = `myrmidon${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const metadata = JSON.stringify({ name, parents: [parentId] });
    const head = new TextEncoder().encode(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
      + `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.byteLength + content.byteLength + tail.byteLength);
    body.set(head, 0);
    body.set(content, head.byteLength);
    body.set(tail, head.byteLength + content.byteLength);
    const response = await (this.deps.fetchImpl ?? fetch)(
      `${UPLOAD_API}/files?uploadType=multipart&fields=${FIELDS}${this.scoping(root)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.token(root)}`,
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body: body as unknown as BodyInit,
      },
    );
    if (response.status === 409) throw new CloudConnectorError(409, "a file with this name already exists (overwrite=false)");
    if (response.status !== 200 && response.status !== 201) throw await this.error(response);
    return describe((await response.json()) as DriveFile);
  }

  private async uploadResumable(root: CloudRoot, parentId: string, name: string, content: Uint8Array): Promise<CloudItem> {
    const start = await (this.deps.fetchImpl ?? fetch)(
      `${UPLOAD_API}/files?uploadType=resumable&fields=${FIELDS}${this.scoping(root)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.token(root)}`,
          "content-type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ name, parents: [parentId] }),
      },
    );
    if (start.status !== 200) throw await this.error(start);
    const location = start.headers.get("location");
    if (!location) throw new CloudConnectorError(502, "the provider did not return an upload session");
    let sent = 0;
    let last: Response | null = null;
    while (sent < content.byteLength) {
      const chunk = content.subarray(sent, sent + UPLOAD_CHUNK);
      const end = sent + chunk.byteLength - 1;
      last = await (this.deps.fetchImpl ?? fetch)(location, {
        method: "PUT",
        headers: { "content-range": `bytes ${sent}-${end}/${content.byteLength}` },
        body: chunk as unknown as BodyInit,
      });
      if (last.status !== 200 && last.status !== 201 && last.status !== 308) {
        throw new CloudConnectorError(502, `upload failed at byte ${sent}`);
      }
      sent += chunk.byteLength;
    }
    if (!last) throw new CloudConnectorError(502, "upload produced no response");
    if (last.status === 308) throw new CloudConnectorError(502, "upload session did not finish");
    return describe((await last.json()) as DriveFile);
  }

  async move(source: CloudLocation, destination: CloudLocation): Promise<CloudItem> {
    if (source.parts.length === 0 || destination.parts.length === 0) {
      throw new CloudConnectorError(400, "give the source and destination paths");
    }
    const file = await this.resolveItem(source);
    const parent = await this.resolveItem({ root: destination.root, parts: destination.parts.slice(0, -1) });
    if (!isFolder(parent)) throw new CloudConnectorError(400, "the destination is not a folder");
    const previous = (file.parents ?? []).join(",");
    const response = await this.request(
      source.root,
      "PATCH",
      `/files/${encodeURIComponent(file.id ?? "")}?addParents=${encodeURIComponent(parent.id ?? "")}`
      + (previous ? `&removeParents=${encodeURIComponent(previous)}` : "")
      + `&fields=${FIELDS}${this.scoping(source.root)}`,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: destination.parts[destination.parts.length - 1] }),
      },
    );
    if (response.status === 409) throw new CloudConnectorError(409, "the destination already exists");
    if (response.status !== 200) throw await this.error(response);
    return describe((await response.json()) as DriveFile);
  }
}
