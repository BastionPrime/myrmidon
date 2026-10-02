// myrmidon(CLOUD-CONNECTOR): access-token resolver tests.
//
// The resolver is what keeps "the connector holds the token, not the bot"
// true over time: it reads the bundle from the connector's secret, refreshes
// it before it expires, writes the new bundle back with a version guard and
// deduplicates concurrent refreshes. The database-backed secret store is
// wired in production; here the store is a fake, so the logic is provable
// without a network or a database.

import { describe, expect, it, vi } from "vitest";
import type { CloudAccount } from "@paperclipai/shared/myrmidon-cloud-connector";
import { createCloudAccessTokenResolver } from "./access-token.js";
import { serializeTokenBundle } from "./oauth.js";
import { memoryCloudTokenStore, type CloudTokenStore } from "./token-store.js";

const NOW = 1_750_000_000_000;

const ACCOUNT: CloudAccount = {
  id: "account-1",
  providerId: "onedrive",
  displayName: "Owner OneDrive",
  companyId: "company-a",
  tokenRef: "secret-1",
  scopes: ["Files.ReadWrite.All"],
  connectedAt: "2026-01-01T00:00:00.000Z",
  connectedBy: "user-owner",
};

const CLIENTS = { onedrive: { clientId: "client-a", clientSecret: "shh", redirectUri: "https://board.example.com/cb" } };

function bundle(overrides: { accessToken: string; expiresAt: number | null; refreshToken?: string | null }): string {
  return serializeTokenBundle({
    accessToken: overrides.accessToken,
    refreshToken: overrides.refreshToken === undefined ? "rt-1" : overrides.refreshToken,
    expiresAt: overrides.expiresAt,
    scopes: [],
    tokenType: "Bearer",
  });
}

function resolverWith(store: CloudTokenStore, fetchImpl?: typeof fetch) {
  return createCloudAccessTokenResolver({
    store,
    clients: CLIENTS,
    fetchImpl,
    now: () => NOW,
    log: { warn: () => {} },
  });
}

describe("cloud access token resolver", () => {
  it("answers nothing when the account has no owner company or no secret", async () => {
    const store = memoryCloudTokenStore();
    const resolve = resolverWith(store);
    expect(await resolve({ ...ACCOUNT, companyId: null })).toBeNull();
    expect(await resolve({ ...ACCOUNT, tokenRef: "" })).toBeNull();
  });

  it("answers nothing when the secret is gone", async () => {
    const resolve = resolverWith(memoryCloudTokenStore());
    expect(await resolve(ACCOUNT)).toBeNull();
  });

  it("answers the stored token while it is still fresh", async () => {
    const store = memoryCloudTokenStore({ "secret-1": { value: bundle({ accessToken: "at-1", expiresAt: NOW + 3_600_000 }), version: 1 } });
    const fetchImpl = vi.fn();
    const resolve = resolverWith(store, fetchImpl as unknown as typeof fetch);
    expect(await resolve(ACCOUNT)).toBe("at-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes shortly before expiry and writes the new bundle back", async () => {
    const store = memoryCloudTokenStore({ "secret-1": { value: bundle({ accessToken: "at-old", expiresAt: NOW + 30_000 }), version: 3 } });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolve = resolverWith(store, fetchImpl as unknown as typeof fetch);

    expect(await resolve(ACCOUNT)).toBe("at-new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = await store.read("company-a", "secret-1");
    expect(stored?.version).toBe(4);
    expect(stored?.value).toContain("at-new");
  });

  it("keeps the old token when the refresh is refused", async () => {
    const store = memoryCloudTokenStore({ "secret-1": { value: bundle({ accessToken: "at-old", expiresAt: NOW }), version: 1 } });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } }),
    );
    const resolve = resolverWith(store, fetchImpl as unknown as typeof fetch);
    expect(await resolve(ACCOUNT)).toBe("at-old");
    expect((await store.read("company-a", "secret-1"))?.version).toBe(1);
  });

  it("does not stampede the provider with concurrent refreshes", async () => {
    const store = memoryCloudTokenStore({ "secret-1": { value: bundle({ accessToken: "at-old", expiresAt: NOW }), version: 1 } });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const resolve = resolverWith(store, fetchImpl as unknown as typeof fetch);
    const [a, b] = await Promise.all([resolve(ACCOUNT), resolve(ACCOUNT)]);
    expect(a).toBe("at-new");
    expect(b).toBe("at-new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers the old token when the bundle has no refresh token", async () => {
    const store = memoryCloudTokenStore({
      "secret-1": { value: bundle({ accessToken: "at-old", expiresAt: NOW - 1, refreshToken: null }), version: 1 },
    });
    const fetchImpl = vi.fn();
    const resolve = resolverWith(store, fetchImpl as unknown as typeof fetch);
    expect(await resolve(ACCOUNT)).toBe("at-old");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps working when the rotate loses a race", async () => {
    const store: CloudTokenStore = {
      write: async () => ({ secretId: "secret-1", version: 1 }),
      read: async () => ({ value: bundle({ accessToken: "at-old", expiresAt: NOW }), version: 1 }),
      rotate: async () => {
        throw new Error("version conflict");
      },
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolve = resolverWith(store, fetchImpl as unknown as typeof fetch);
    expect(await resolve(ACCOUNT)).toBe("at-new");
  });
});