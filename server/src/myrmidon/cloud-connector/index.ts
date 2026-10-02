// myrmidon(CLOUD-CONNECTOR): wiring for app.ts.
//
// One process-wide service: the routes and (later, part B) the agent-facing
// MCP tools share the same state. Part A registers the OneDrive provider; the
// access token comes from the caller so the connector never reads a bot's
// credentials. With no token resolver the account is simply not connected and
// cloud calls refuse with a 409 the owner can act on.

import type { Db } from "@paperclipai/db";
import { CloudProviderRegistry, type CloudProvider } from "./providers/provider.js";
import { OneDriveProvider } from "./providers/onedrive.js";
import { cloudConnectorService } from "./service.js";
import { cloudConnectorRoutes } from "./routes.js";

export interface CloudConnectorWiringOptions {
  /** Resolves the connector account's access token; null means "not connected". */
  accessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Extra providers (part C adds Google Drive and Yandex Disk here). */
  providers?: readonly CloudProvider[];
}

export function myrmidonCloudConnectorRoutes(db: Db, options: CloudConnectorWiringOptions = {}) {
  const accessToken = options.accessToken ?? (async () => null);
  const providers = new CloudProviderRegistry([
    new OneDriveProvider({ accessToken, fetchImpl: options.fetchImpl }),
    ...(options.providers ?? []),
  ]);
  const service = cloudConnectorService({ db, providers });
  return cloudConnectorRoutes({ service });
}

export { cloudConnectorService, CloudConnectorService } from "./service.js";
export { CloudProviderRegistry } from "./providers/provider.js";
export { OneDriveProvider } from "./providers/onedrive.js";