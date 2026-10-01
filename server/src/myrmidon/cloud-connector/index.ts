// myrmidon(CLOUD-CONNECTOR): wiring for app.ts.
//
// One process-wide service: the owner/agent routes and the agent MCP surface
// share the same state. The owner connects an account through the provider's
// OAuth flow; the token lands in a company secret of the instance's secret
// store, and the access-token resolver reads and refreshes it on demand, so
// no bot ever holds a cloud token.
//
// Provider client credentials come from the environment (our production
// values live in the deploy repository); with none set, the connector still
// serves the folder/grant/journal surface but refuses to start a connect.

import type { Db } from "@paperclipai/db";
import { Router } from "express";
import type { CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import { OAuthStateStore, readOAuthClients } from "./oauth.js";
import { createCloudAccessTokenResolver, type CloudAccessTokenResolver } from "./access-token.js";
import { secretCloudTokenStore, type CloudTokenStore } from "./token-store.js";
import { CloudProviderRegistry, type CloudProvider } from "./providers/provider.js";
import { OneDriveProvider } from "./providers/onedrive.js";
import { cloudConnectorService, type CloudConnectorService } from "./service.js";
import { cloudConnectorRoutes } from "./routes.js";
import { cloudConnectorMcpRoutes } from "./mcp.js";
import { agentRoleFromDb, dbCloudConnectorStore, type CloudConnectorStore } from "./store.js";

export interface CloudConnectorWiringOptions {
  /** Override for tests; production uses the instance settings row. */
  store?: CloudConnectorStore;
  /** Override for tests; production uses the instance secret store. */
  tokenStore?: CloudTokenStore;
  /** Override for tests; production reads MYRMIDON_CLOUD_<PROVIDER>_CLIENT_ID/_SECRET. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Extra providers (Google Drive and Yandex Disk register here). */
  providers?: readonly CloudProvider[];
  stateStore?: OAuthStateStore;
}

export interface CloudConnectorWiring {
  routes: Router;
  service: CloudConnectorService;
  /** Access token of the account that owns a root; null when nobody connected it. */
  accessToken: (root: CloudRoot) => Promise<string | null>;
}

export function createCloudConnector(options: { db: Db } & CloudConnectorWiringOptions): CloudConnectorWiring {
  const env = options.env ?? process.env;
  const documentStore = options.store ?? dbCloudConnectorStore(options.db);
  const tokenStore = options.tokenStore ?? secretCloudTokenStore(options.db);
  const clients = readOAuthClients(env, env.MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE ?? null);
  const resolveAccountToken: CloudAccessTokenResolver = createCloudAccessTokenResolver({
    store: tokenStore,
    clients,
    fetchImpl: options.fetchImpl,
  });

  const accessToken = async (root: CloudRoot): Promise<string | null> => {
    if (!root.companyId) return null;
    const document = await documentStore.read();
    const account = document.accounts.find(
      (entry) => entry.providerId === root.providerId && entry.companyId === root.companyId,
    );
    return account ? resolveAccountToken(account) : null;
  };

  const providers = new CloudProviderRegistry([
    new OneDriveProvider({ accessToken, fetchImpl: options.fetchImpl }),
    ...(options.providers ?? []),
  ]);

  const service = cloudConnectorService({
    db: options.db,
    store: documentStore,
    providers,
    agentRole: agentRoleFromDb(options.db),
    oauth: {
      clients,
      stateStore: options.stateStore ?? new OAuthStateStore(),
      tokenStore,
      fetchImpl: options.fetchImpl,
    },
  });

  // One mount for app.ts: the owner/agent routes and the agent MCP surface.
  const router = Router();
  router.use(cloudConnectorRoutes({ service }));
  router.use(cloudConnectorMcpRoutes({ service }));

  return { routes: router, service, accessToken };
}

export function myrmidonCloudConnectorRoutes(db: Db, options: CloudConnectorWiringOptions = {}) {
  return createCloudConnector({ db, ...options }).routes;
}

export { cloudConnectorService, CloudConnectorService } from "./service.js";
export { CloudProviderRegistry } from "./providers/provider.js";
export { OneDriveProvider } from "./providers/onedrive.js";
export { secretCloudTokenStore, memoryCloudTokenStore } from "./token-store.js";
export { cloudConnectorMcpRoutes, CLOUD_MCP_TOOLS } from "./mcp.js";
export { createCloudAccessTokenResolver } from "./access-token.js";
export { OAuthStateStore, CLOUD_OAUTH_SPECS, readOAuthClients } from "./oauth.js";