// myrmidon(CLOUD-CONNECTOR): the owner's OAuth connect flow.
//
// The owner connects a cloud once and the connector keeps the token; no bot
// ever sees it. This file knows the three providers' authorization and token
// endpoints, builds the authorization URL (PKCE where the provider supports
// it), exchanges the code and refreshes the token. Everything takes an
// injected fetch and clock so the flow is testable without a network.

import { createHash, randomBytes } from "node:crypto";
import type { CloudProviderId } from "@paperclipai/shared/myrmidon-cloud-connector";

/** The token bundle we keep in the connector's secret, never in a bot. */
export interface CloudTokenBundle {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when the provider did not say. */
  expiresAt: number | null;
  scopes: string[];
  tokenType: string;
}

export interface OAuthProviderSpec {
  readonly id: CloudProviderId;
  readonly displayName: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scopes: string[];
  readonly usePkce: boolean;
  /** Microsoft wants scopes space separated and `offline_access` for a refresh token. */
  readonly scopeSeparator: " " | ",";
  readonly extraAuthorizeParams?: Record<string, string>;
}

export const CLOUD_OAUTH_SPECS: Record<CloudProviderId, OAuthProviderSpec> = {
  onedrive: {
    id: "onedrive",
    displayName: "OneDrive",
    authorizeEndpoint: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    scopes: ["Files.ReadWrite.All", "offline_access", "User.Read"],
    usePkce: true,
    scopeSeparator: " ",
  },
  "google-drive": {
    id: "google-drive",
    displayName: "Google Drive",
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive"],
    usePkce: true,
    scopeSeparator: " ",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  "yandex-disk": {
    id: "yandex-disk",
    displayName: "Yandex Disk",
    authorizeEndpoint: "https://oauth.yandex.ru/authorize",
    tokenEndpoint: "https://oauth.yandex.ru/token",
    scopes: ["cloud_api:disk.read", "cloud_api:disk.write"],
    usePkce: false,
    scopeSeparator: " ",
  },
};

export interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
}

/**
 * Client credentials come from the environment (our production values live in
 * the deploy repository); a provider without them is simply not connectable.
 */
export function readOAuthClients(
  env: NodeJS.ProcessEnv,
  redirectBase: string | null,
): Partial<Record<CloudProviderId, OAuthClient>> {
  const clients: Partial<Record<CloudProviderId, OAuthClient>> = {};
  const definitions: Array<[CloudProviderId, string]> = [
    ["onedrive", "ONEDRIVE"],
    ["google-drive", "GOOGLE_DRIVE"],
    ["yandex-disk", "YANDEX_DISK"],
  ];
  for (const [providerId, suffix] of definitions) {
    const clientId = env[`MYRMIDON_CLOUD_${suffix}_CLIENT_ID`]?.trim();
    if (!clientId) continue;
    clients[providerId] = {
      clientId,
      clientSecret: env[`MYRMIDON_CLOUD_${suffix}_CLIENT_SECRET`]?.trim() || null,
      redirectUri: `${(redirectBase ?? "").replace(/\/+$/, "")}/api/myrmidon/cloud-connector/oauth/callback`,
    };
  }
  return clients;
}

export function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function codeChallengeFor(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(input: {
  spec: OAuthProviderSpec;
  client: OAuthClient;
  state: string;
  codeVerifier: string | null;
  scopes?: string[];
}): string {
  const { spec, client, state, codeVerifier } = input;
  const url = new URL(spec.authorizeEndpoint);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("scope", (input.scopes ?? spec.scopes).join(spec.scopeSeparator));
  url.searchParams.set("state", state);
  if (spec.usePkce && codeVerifier) {
    url.searchParams.set("code_challenge", codeChallengeFor(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(spec.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(raw: RawTokenResponse, previousRefreshToken: string | null, now: () => number): CloudTokenBundle {
  if (!raw.access_token) {
    throw new Error(raw.error_description ?? raw.error ?? "the provider returned no access token");
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? previousRefreshToken,
    expiresAt: typeof raw.expires_in === "number" ? now() + raw.expires_in * 1000 : null,
    scopes: typeof raw.scope === "string" && raw.scope.length > 0 ? raw.scope.split(/[ ,]+/).filter(Boolean) : [],
    tokenType: raw.token_type ?? "Bearer",
  };
}

async function tokenRequest(input: {
  spec: OAuthProviderSpec;
  client: OAuthClient;
  body: URLSearchParams;
  fetchImpl: typeof fetch;
  previousRefreshToken: string | null;
  now: () => number;
}): Promise<CloudTokenBundle> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const response = await input.fetchImpl(input.spec.tokenEndpoint, {
    method: "POST",
    headers,
    body: input.body.toString(),
  });
  const text = await response.text();
  let raw: RawTokenResponse = {};
  try {
    raw = JSON.parse(text) as RawTokenResponse;
  } catch {
    raw = {};
  }
  if (!response.ok) {
    throw new Error(raw.error_description ?? raw.error ?? `the provider refused the token request (HTTP ${response.status})`);
  }
  return parseTokenResponse(raw, input.previousRefreshToken, input.now);
}

export async function exchangeCode(input: {
  spec: OAuthProviderSpec;
  client: OAuthClient;
  code: string;
  codeVerifier: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<CloudTokenBundle> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.client.redirectUri,
    client_id: input.client.clientId,
  });
  if (input.client.clientSecret) body.set("client_secret", input.client.clientSecret);
  if (input.spec.usePkce && input.codeVerifier) body.set("code_verifier", input.codeVerifier);
  return tokenRequest({
    spec: input.spec,
    client: input.client,
    body,
    fetchImpl: input.fetchImpl ?? fetch,
    previousRefreshToken: null,
    now: input.now ?? (() => Date.now()),
  });
}

export async function refreshTokenBundle(input: {
  spec: OAuthProviderSpec;
  client: OAuthClient;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<CloudTokenBundle> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
  });
  if (input.client.clientSecret) body.set("client_secret", input.client.clientSecret);
  return tokenRequest({
    spec: input.spec,
    client: input.client,
    body,
    fetchImpl: input.fetchImpl ?? fetch,
    previousRefreshToken: input.refreshToken,
    now: input.now ?? (() => Date.now()),
  });
}

/**
 * Single-use, short-lived connect states. The state is what ties the callback
 * (which the cloud provider sends back to the browser) to the owner who
 * started the connect; it also carries the PKCE verifier.
 */
export class OAuthStateStore {
  private readonly states = new Map<string, { providerId: CloudProviderId; companyId: string; userId: string; verifier: string | null; displayName: string | null; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs = 10 * 60_000) {}

  issue(input: { providerId: CloudProviderId; companyId: string; userId: string; verifier: string | null; displayName?: string | null }): string {
    const state = base64Url(randomBytes(24));
    this.states.set(state, {
      providerId: input.providerId,
      companyId: input.companyId,
      userId: input.userId,
      verifier: input.verifier,
      displayName: input.displayName ?? null,
      expiresAt: this.now() + this.ttlMs,
    });
    this.prune();
    return state;
  }

  consume(state: string): { providerId: CloudProviderId; companyId: string; userId: string; verifier: string | null; displayName: string | null } | null {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return {
      providerId: entry.providerId,
      companyId: entry.companyId,
      userId: entry.userId,
      verifier: entry.verifier,
      displayName: entry.displayName,
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.states) {
      if (entry.expiresAt <= now) this.states.delete(key);
    }
  }
}

/** What the connector writes into its secret: the bundle plus its bookkeeping. */
export function serializeTokenBundle(bundle: CloudTokenBundle): string {
  return JSON.stringify({ version: 1, ...bundle });
}

export function parseTokenBundle(raw: string | null): CloudTokenBundle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CloudTokenBundle> & { version?: number };
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope): scope is string => typeof scope === "string") : [],
      tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "Bearer",
    };
  } catch {
    return null;
  }
}