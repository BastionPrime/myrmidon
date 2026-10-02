// myrmidon(CLOUD-CONNECTOR): the Yandex Disk provider (REST API v1).
//
// Yandex Disk addresses everything by a real path (`disk:/...`), so an own
// root is built from the folder the owner recorded plus the confined segments
// the caller passes — an agent-supplied id is never involved. Two honest
// limits, both refused with a message the agent can act on rather than
// silently approximated:
//   * Yandex has no shared-drive addressing, so a `shared` root is refused;
//     the owner records the folder as an own root instead.
//   * Yandex has no search endpoint, so `search` walks the granted root (depth
//     and item capped) — which also means a hit can never be outside it.

import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { CloudConnectorError, type CloudItem, type CloudListing } from "../types.js";
import { normalizeCloudName, joinCloudPath } from "../paths.js";
import type { CloudLocation, CloudProvider, CloudSearchHit } from "./provider.js";

const API = "https://cloud-api.yandex.net/v1/disk";
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_ITEMS = 2000;
const POLL_ATTEMPTS = 6;

export interface YandexDiskProviderDeps {
  /** Resolves the access token of the account that owns this root; null when not connected. */
  accessToken: (root: CloudRoot) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Delay between polls while an async operation settles; tests set 0. */
  pollDelayMs?: number;
}

interface YandexResource {
  name?: string;
  type?: "dir" | "file";
  size?: number;
  modified?: string;
  path?: string;
  mime_type?: string;
  _embedded?: { items?: YandexResource[]; total?: number; limit?: number; offset?: number };
}

interface YandexLink {
  href?: string;
  method?: string;
}

function describe(resource: YandexResource): CloudItem {
  const folder = resource.type === "dir";
  return {
    name: resource.name ?? "",
    type: folder ? "folder" : "file",
    size: folder ? null : (resource.size ?? 0),
    modified: resource.modified ? resource.modified.slice(0, 19) : null,
    children: null,
  };
}

export class YandexDiskProvider implements CloudProvider {
  readonly id = "yandex-disk" as const;
  readonly displayName = "Yandex Disk";

  constructor(private readonly deps: YandexDiskProviderDeps) {}

  private async token(root: CloudRoot): Promise<string> {
    const token = await this.deps.accessToken(root);
    if (!token) {
      throw new CloudConnectorError(409, "the Yandex Disk account is not connected; the owner must connect it first");
    }
    return token;
  }

  private async request(
    root: CloudRoot,
    method: string,
    url: string,
    init: RequestInit = {},
    withAuth = true,
  ): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return fetchImpl(url.startsWith("http") ? url : `${API}${url}`, {
      ...init,
      method,
      headers: {
        ...(withAuth ? { authorization: `Bearer ${await this.token(root)}` } : {}),
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
      const body = (await response.json()) as { description?: string; message?: string };
      if (body?.description) message = body.description;
      else if (body?.message) message = body.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    return new CloudConnectorError(mapped as 403 | 404 | 409 | 502, message);
  }

  // -- addressing ----------------------------------------------------------

  /** `disk:/<root folder>/<segments>`. Never built from anything but confined parts. */
  private diskPath(root: CloudRoot, parts: readonly string[]): string {
    if (root.kind === "shared") {
      throw new CloudConnectorError(
        400,
        "Yandex Disk has no shared-folder addressing; record this folder as an own root instead",
      );
    }
    const segments = [...(root.folder ?? "").split("/").filter((part) => part.length > 0), ...parts];
    return `disk:/${segments.join("/")}`;
  }

  private async resource(root: CloudRoot, path: string): Promise<YandexResource> {
    return this.json<YandexResource>(root, "GET", `/resources?path=${encodeURIComponent(path)}`);
  }

  private async children(root: CloudRoot, path: string, limit: number): Promise<YandexResource[]> {
    const out: YandexResource[] = [];
    let offset = 0;
    while (out.length < limit) {
      const page = await this.json<YandexResource>(
        root,
        "GET",
        `/resources?path=${encodeURIComponent(path)}&limit=${Math.min(limit - out.length, 1000)}&offset=${offset}`,
      );
      const items = page._embedded?.items ?? [];
      out.push(...items);
      offset += items.length;
      if (items.length === 0) break;
    }
    return out.slice(0, limit);
  }

  /** Distributed storage is eventually consistent: wait for the item to appear. */
  private async settle(root: CloudRoot, path: string): Promise<YandexResource> {
    let last: CloudConnectorError | null = null;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      try {
        return await this.resource(root, path);
      } catch (error) {
        if (!(error instanceof CloudConnectorError) || error.status !== 404) throw error;
        last = error;
        const delay = this.deps.pollDelayMs ?? 200;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw last ?? new CloudConnectorError(502, "the cloud provider did not report the item in time");
  }

  // -- reads ---------------------------------------------------------------

  async list(location: CloudLocation, limit: number): Promise<CloudListing> {
    const folder = await this.resource(location.root, this.diskPath(location.root, location.parts));
    if (folder.type !== "dir") throw new CloudConnectorError(400, "not a folder");
    const kids = await this.children(location.root, this.diskPath(location.root, location.parts), limit + 1);
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
    const rootPath = this.diskPath(location.root, location.parts);
    const needle = normalizeCloudName(trimmed);
    const prefix = `${rootPath}/`;
    const out: CloudSearchHit[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && out.length < limit && visited < SEARCH_MAX_ITEMS) {
      const current = queue.shift()!;
      const items = await this.children(location.root, current.path, 1000);
      visited += items.length;
      for (const item of items) {
        const path = item.path ?? "";
        if (!path.startsWith(prefix)) continue; // never show anything outside the root
        const relative = path.slice(prefix.length);
        if (normalizeCloudName(item.name ?? "").includes(needle)) {
          out.push({ path: joinCloudPath(relative.split("/")), item: describe(item) });
        }
        if (item.type === "dir" && current.depth + 1 < SEARCH_MAX_DEPTH) {
          queue.push({ path, depth: current.depth + 1 });
        }
      }
    }
    return out.slice(0, limit);
  }

  async readBytes(location: CloudLocation, limit: number): Promise<{ item: CloudItem; content: Uint8Array }> {
    const path = this.diskPath(location.root, location.parts);
    const file = await this.resource(location.root, path);
    if (file.type === "dir") throw new CloudConnectorError(400, "not a file");
    if ((file.size ?? 0) > limit) {
      throw new CloudConnectorError(400, `file is ${file.size ?? 0} bytes, more than ${limit}; use download`);
    }
    const link = await this.json<YandexLink>(
      location.root,
      "GET",
      `/resources/download?path=${encodeURIComponent(path)}`,
    );
    if (!link.href) throw new CloudConnectorError(502, "the provider did not return a download link");
    // The link is pre-signed and short-lived: the account token never goes to the storage host.
    const response = await this.request(location.root, "GET", link.href, { redirect: "follow" }, false);
    if (response.status !== 200) throw await this.error(response);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new CloudConnectorError(400, "file grew past the limit; use download");
    return { item: describe(file), content: buffer };
  }

  // -- writes (own roots only; the caller has checked rw) ------------------

  async ensureFolder(location: CloudLocation): Promise<CloudItem> {
    const segments = [
      ...(location.root.kind === "shared" ? [] : (location.root.folder ?? "").split("/").filter((part) => part.length > 0)),
      ...location.parts,
    ];
    let path = "disk:";
    let resource: YandexResource | null = null;
    for (const segment of segments) {
      path = `${path}/${segment}`;
      const response = await this.request(location.root, "PUT", `/resources?path=${encodeURIComponent(path)}`);
      if (response.status !== 201 && response.status !== 409) throw await this.error(response);
      if (response.status === 409) {
        const existing = await this.resource(location.root, path);
        if (existing.type !== "dir") throw new CloudConnectorError(400, "a file is in the way of this folder");
        resource = existing;
      }
    }
    if (resource) return describe(resource);
    return describe(await this.settle(location.root, path));
  }

  async upload(location: CloudLocation, content: Uint8Array, overwrite: boolean): Promise<CloudItem> {
    if (location.parts.length === 0) throw new CloudConnectorError(400, "give a file path");
    await this.ensureFolder({ root: location.root, parts: location.parts.slice(0, -1) });
    const path = this.diskPath(location.root, location.parts);
    const link = await this.json<YandexLink>(
      location.root,
      "GET",
      `/resources/upload?path=${encodeURIComponent(path)}&overwrite=${overwrite ? "true" : "false"}`,
    );
    if (!link.href) throw new CloudConnectorError(502, "the provider did not return an upload link");
    // Pre-signed upload link: the account token stays with the API host.
    const response = await this.request(
      location.root,
      link.method === "POST" ? "POST" : "PUT",
      link.href,
      { headers: { "content-type": "application/octet-stream" }, body: content as unknown as BodyInit },
      false,
    );
    if (response.status === 409) {
      throw new CloudConnectorError(409, "a file with this name already exists (overwrite=false)");
    }
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      throw await this.error(response);
    }
    return describe(await this.settle(location.root, path));
  }

  async move(source: CloudLocation, destination: CloudLocation): Promise<CloudItem> {
    if (source.parts.length === 0 || destination.parts.length === 0) {
      throw new CloudConnectorError(400, "give the source and destination paths");
    }
    const from = this.diskPath(source.root, source.parts);
    const to = this.diskPath(destination.root, destination.parts);
    const response = await this.request(
      source.root,
      "POST",
      `/resources/move?from=${encodeURIComponent(from)}&path=${encodeURIComponent(to)}&overwrite=false`,
    );
    if (response.status === 409) throw new CloudConnectorError(409, "the destination already exists");
    if (response.status !== 201 && response.status !== 202) throw await this.error(response);
    return describe(await this.settle(destination.root, to));
  }
}