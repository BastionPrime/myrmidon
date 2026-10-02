// myrmidon(CLOUD-CONNECTOR): the account's access token, refreshed on demand.
//
// A provider asks for a token per call; this resolver reads the bundle from
// the connector's secret, refreshes it shortly before it expires, writes the
// new bundle back (with a version guard) and answers the access token. It
// deduplicates concurrent refreshes of the same account so a burst of calls
// does not stampede the provider.

import type { CloudAccount, CloudProviderId } from "@paperclipai/shared/myrmidon-cloud-connector";
import { logger } from "../../middleware/logger.js";
import {
  CLOUD_OAUTH_SPECS,
  parseTokenBundle,
  refreshTokenBundle,
  serializeTokenBundle,
  type OAuthClient,
  type OAuthProviderSpec,
} from "./oauth.js";
import type { CloudTokenStore } from "./token-store.js";

/** Refresh this long before the stated expiry, so a call never races it. */
export const CLOUD_TOKEN_REFRESH_SKEW_MS = 60_000;

export interface CloudAccessTokenDeps {
  store: CloudTokenStore;
  clients: Partial<Record<CloudProviderId, OAuthClient>>;
  specs?: Record<CloudProviderId, OAuthProviderSpec>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
  log?: Pick<typeof logger, "warn">;
}

export type CloudAccessTokenResolver = (account: CloudAccount) => Promise<string | null>;

export function createCloudAccessTokenResolver(deps: CloudAccessTokenDeps): CloudAccessTokenResolver {
  const specs = deps.specs ?? CLOUD_OAUTH_SPECS;
  const now = deps.now ?? (() => Date.now());
  const skew = deps.refreshSkewMs ?? CLOUD_TOKEN_REFRESH_SKEW_MS;
  const log = deps.log ?? logger;
  const inFlight = new Map<string, Promise<string | null>>();

  async function resolve(account: CloudAccount): Promise<string | null> {
    if (!account.companyId || !account.tokenRef) return null;
    const current = await deps.store.read(account.companyId, account.tokenRef);
    if (!current) return null;
    const bundle = parseTokenBundle(current.value);
    if (!bundle) return null;

    const stillFresh = bundle.expiresAt === null || bundle.expiresAt - now() > skew;
    if (stillFresh || !bundle.refreshToken) return bundle.accessToken;

    const spec = specs[account.providerId];
    const client = deps.clients[account.providerId];
    if (!spec || !client) return bundle.accessToken;

    const key = account.tokenRef;
    const running = inFlight.get(key);
    if (running) return running;

    const refresh = (async (): Promise<string | null> => {
      try {
        const refreshed = await refreshTokenBundle({
          spec,
          client,
          refreshToken: bundle.refreshToken!,
          fetchImpl: deps.fetchImpl,
          now,
        });
        try {
          await deps.store.rotate({
            secretId: account.tokenRef,
            value: serializeTokenBundle(refreshed),
            expectedLatestVersion: current.version,
          });
        } catch (error) {
          // Another run refreshed first: keep the freshly read token instead of failing the call.
          log.warn?.(`myrmidon cloud connector: token rotate lost a race (${(error as Error).message})`);
        }
        return refreshed.accessToken;
      } catch (error) {
        // The owner has to reconnect: keep the old token so the provider answers its own 401.
        log.warn?.(`myrmidon cloud connector: token refresh failed (${(error as Error).message})`);
        return bundle.accessToken;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, refresh);
    return refresh;
  }

  return resolve;
}