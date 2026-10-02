// myrmidon(CLOUD-CONNECTOR): OAuth flow tests.
//
// The connect flow is the only place the owner's token is handled. These
// tests pin the authorization URL, the PKCE pair, the code exchange, the
// refresh and the single-use state — all against a fake fetch, so no network
// and no real credentials are ever used.

import { describe, expect, it } from "vitest";
import {
  CLOUD_OAUTH_SPECS,
  OAuthStateStore,
  buildAuthorizeUrl,
  codeChallengeFor,
  createCodeVerifier,
  exchangeCode,
  parseTokenBundle,
  readOAuthClients,
  refreshTokenBundle,
  serializeTokenBundle,
} from "./oauth.js";

const CLIENT = {
  clientId: "client-a",
  clientSecret: "shh",
  redirectUri: "https://board.example.com/api/myrmidon/cloud-connector/oauth/callback",
};

const NOW = 1_750_000_000_000;

function tokenJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("buildAuthorizeUrl", () => {
  it("carries the client, the redirect and the state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        spec: CLOUD_OAUTH_SPECS.onedrive,
        client: CLIENT,
        state: "state-a",
        codeVerifier: "verifier-a",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-a");
    expect(url.searchParams.get("redirect_uri")).toBe(CLIENT.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-a");
    expect(url.searchParams.get("scope")).toBe("Files.ReadWrite.All offline_access User.Read");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallengeFor("verifier-a"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("adds the provider's extra parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({ spec: CLOUD_OAUTH_SPECS["google-drive"], client: CLIENT, state: "s", codeVerifier: "v" }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("skips PKCE for a provider that does not support it", () => {
    const url = new URL(
      buildAuthorizeUrl({ spec: CLOUD_OAUTH_SPECS["yandex-disk"], client: CLIENT, state: "s", codeVerifier: "v" }),
    );
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });
});

describe("PKCE", () => {
  it("derives a stable challenge from the verifier", () => {
    const verifier = createCodeVerifier();
    expect(codeChallengeFor(verifier)).toBe(codeChallengeFor(verifier));
    expect(codeChallengeFor(verifier)).not.toBe(verifier);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("exchangeCode", () => {
  it("posts the code with the verifier and computes the expiry", async () => {
    let seen: URLSearchParams | null = null;
    const bundle = await exchangeCode({
      spec: CLOUD_OAUTH_SPECS.onedrive,
      client: CLIENT,
      code: "code-a",
      codeVerifier: "verifier-a",
      now: () => NOW,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = new URLSearchParams(String(init.body));
        return tokenJson({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "Files.ReadWrite.All", token_type: "Bearer" });
      }) as unknown as typeof fetch,
    });
    expect(seen!.get("grant_type")).toBe("authorization_code");
    expect(seen!.get("code")).toBe("code-a");
    expect(seen!.get("code_verifier")).toBe("verifier-a");
    expect(seen!.get("redirect_uri")).toBe(CLIENT.redirectUri);
    expect(bundle).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", tokenType: "Bearer" });
    expect(bundle.expiresAt).toBe(NOW + 3_600_000);
  });

  it("reports the provider's refusal message", async () => {
    await expect(
      exchangeCode({
        spec: CLOUD_OAUTH_SPECS.onedrive,
        client: CLIENT,
        code: "bad",
        codeVerifier: null,
        fetchImpl: (async () => tokenJson({ error: "invalid_grant", error_description: "the code expired" }, 400)) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/the code expired/);
  });
});

describe("refreshTokenBundle", () => {
  it("posts the refresh grant and keeps the old refresh token when none is returned", async () => {
    let seen: URLSearchParams | null = null;
    const bundle = await refreshTokenBundle({
      spec: CLOUD_OAUTH_SPECS.onedrive,
      client: CLIENT,
      refreshToken: "rt-1",
      now: () => NOW,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = new URLSearchParams(String(init.body));
        return tokenJson({ access_token: "at-2", expires_in: 60 });
      }) as unknown as typeof fetch,
    });
    expect(seen!.get("grant_type")).toBe("refresh_token");
    expect(seen!.get("refresh_token")).toBe("rt-1");
    expect(bundle.accessToken).toBe("at-2");
    expect(bundle.refreshToken).toBe("rt-1");
    expect(bundle.expiresAt).toBe(NOW + 60_000);
  });
});

describe("OAuthStateStore", () => {
  it("issues a single-use state", () => {
    const store = new OAuthStateStore(() => NOW);
    const state = store.issue({ providerId: "onedrive", companyId: "company-a", userId: "user-a", verifier: "v" });
    expect(store.consume(state)).toMatchObject({ providerId: "onedrive", companyId: "company-a", verifier: "v" });
    expect(store.consume(state)).toBeNull();
  });

  it("expires a state that sat too long", () => {
    let clock = NOW;
    const store = new OAuthStateStore(() => clock);
    const state = store.issue({ providerId: "onedrive", companyId: "company-a", userId: "user-a", verifier: null });
    clock += 11 * 60_000;
    expect(store.consume(state)).toBeNull();
  });
});

describe("readOAuthClients", () => {
  it("builds a client per configured provider", () => {
    const clients = readOAuthClients(
      {
        MYRMIDON_CLOUD_ONEDRIVE_CLIENT_ID: "onedrive-id",
        MYRMIDON_CLOUD_ONEDRIVE_CLIENT_SECRET: "onedrive-secret",
        MYRMIDON_CLOUD_GOOGLE_DRIVE_CLIENT_ID: "google-id",
      } as NodeJS.ProcessEnv,
      "https://board.example.com/",
    );
    expect(clients.onedrive).toMatchObject({ clientId: "onedrive-id", clientSecret: "onedrive-secret" });
    expect(clients["google-drive"]?.clientSecret).toBeNull();
    expect(clients["google-drive"]?.redirectUri).toBe(
      "https://board.example.com/api/myrmidon/cloud-connector/oauth/callback",
    );
    expect(clients["yandex-disk"]).toBeUndefined();
  });

  it("leaves the redirect relative when no base is configured, so the connect refuses to start", () => {
    const clients = readOAuthClients({ MYRMIDON_CLOUD_ONEDRIVE_CLIENT_ID: "id" } as NodeJS.ProcessEnv, null);
    expect(clients.onedrive?.redirectUri.startsWith("http")).toBe(false);
  });
});

describe("token bundle serialization", () => {
  it("round-trips a bundle", () => {
    const bundle = { accessToken: "at", refreshToken: "rt", expiresAt: NOW, scopes: ["s1"], tokenType: "Bearer" };
    expect(parseTokenBundle(serializeTokenBundle(bundle))).toEqual(bundle);
  });

  it("reads anything malformed as absent", () => {
    expect(parseTokenBundle(null)).toBeNull();
    expect(parseTokenBundle("not json")).toBeNull();
    expect(parseTokenBundle(JSON.stringify({ refreshToken: "rt" }))).toBeNull();
  });
});