// myrmidon(CLOUD-CONNECTOR): the provider contract.
//
// A provider is the only thing that knows a cloud's HTTP API. The connector
// core never sees a provider item id from an agent: it hands the provider a
// root and a path that has already been confined. Adding a cloud means
// implementing this interface and registering it — no core changes.

import type { CloudProviderId, CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import type { CloudItem, CloudListing } from "../types.js";

/** Where a path points: a root and the segments inside it. */
export interface CloudLocation {
  root: CloudRoot;
  parts: string[];
}

/** A search hit with the path inside the granted root it was verified to be in. */
export interface CloudSearchHit {
  path: string;
  item: CloudItem;
}

export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly displayName: string;

  list(location: CloudLocation, limit: number): Promise<CloudListing>;
  search(location: CloudLocation, query: string, limit: number): Promise<CloudSearchHit[]>;
  readBytes(location: CloudLocation, limit: number): Promise<{ item: CloudItem; content: Uint8Array }>;
  upload(location: CloudLocation, content: Uint8Array, overwrite: boolean): Promise<CloudItem>;
  move(source: CloudLocation, destination: CloudLocation): Promise<CloudItem>;
  ensureFolder(location: CloudLocation): Promise<CloudItem>;
}

export class CloudProviderRegistry {
  private readonly providers = new Map<CloudProviderId, CloudProvider>();

  constructor(providers: readonly CloudProvider[] = []) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  has(id: CloudProviderId): boolean {
    return this.providers.has(id);
  }

  get(id: CloudProviderId): CloudProvider | null {
    return this.providers.get(id) ?? null;
  }

  ids(): CloudProviderId[] {
    return [...this.providers.keys()];
  }
}