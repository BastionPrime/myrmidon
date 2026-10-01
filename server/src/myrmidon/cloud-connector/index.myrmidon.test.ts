// myrmidon(CLOUD-CONNECTOR): wiring tests.
//
// The wiring is the seam that makes the promise real: the owner connects an
// account, the token goes into the connector's secret, and a provider asking
// for a token gets the one belonging to the company that owns the folder —
// never another company's, and never null-but-silent when nobody connected.

import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { createCloudConnector } from "./index.js";
import { OAuthStateStore } from "./oauth.js";
import { memoryCloudTokenStore } from "./token-store.js";
import { memoryCloudConnectorStore } from "./store.js";

const NOW = 1_750_000_000_000;
const COMPANY = "22222222-2222-4222-8222-222222222222";

const ENV = {
  MYRMIDON_CLOUD_ONEDRIVE_CLIENT_ID: "client-a",
  MYRMIDON_CLOUD_ONEDRIVE_CLIENT_SECRET: "shh",
  MYRMIDON_CLOUD_CONNECTOR_REDIRECT_BASE: "https://board.example.com",
} as NodeJS.ProcessEnv;

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: "token-a", refresh_token: "refresh-a", expires_in: 3600, token_type: "Bearer" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function wiring(env: NodeJS.ProcessEnv = ENV) {
  const tokenStore = memoryCloudTokenStore();
  const connector = createCloudConnector({
    db: {} as Db,
    store: memoryCloudConnectorStore(),
    tokenStore,
    env,
    stateStore: new OAuthStateStore(() => NOW),
    fetchImpl: (async () => tokenResponse()) as unknown as typeof fetch,
  });
  return { connector, tokenStore };
}

describe("cloud connector wiring", () => {
  it("connects an account and hands the provider the company's token", async () => {
    const { connector } = wiring();
    const started = await connector.service.beginConnect({ providerId: "onedrive", companyId: COMPANY, userId: "user-owner" });
    expect(new URL(started.authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "https://board.example.com/api/myrmidon/cloud-connector/oauth/callback",
    );

    const account = await connector.service.completeConnect({ state: started.state, code: "code-a" });
    expect(account).toMatchObject({ providerId: "onedrive", companyId: COMPANY });

    const root = await connector.service.createRoot(
      { providerId: "onedrive", companyId: COMPANY, name: "work", kind: "own", folder: "Agents/agent-a" },
      "user-owner",
    );
    expect(await connector.accessToken(root)).toBe("token-a");
  });

  it("answers no token for a company that never connected", async () => {
    const { connector } = wiring();
    const root = await connector.service.createRoot(
      { providerId: "onedrive", companyId: "company-other", name: "work", kind: "own", folder: "Agents/agent-a" },
      "user-owner",
    );
    expect(await connector.accessToken(root)).toBeNull();
  });

  it("refuses to start a connect when no client is configured for the provider", async () => {
    const { connector } = wiring({} as NodeJS.ProcessEnv);
    await expect(
      connector.service.beginConnect({ providerId: "onedrive", companyId: COMPANY, userId: "user-owner" }),
    ).rejects.toThrow(/not configured/);
  });

  it("keeps the token out of the account record", async () => {
    const { connector, tokenStore } = wiring();
    const started = await connector.service.beginConnect({ providerId: "onedrive", companyId: COMPANY, userId: "user-owner" });
    await connector.service.completeConnect({ state: started.state, code: "code-a" });
    const accounts = await connector.service.listAccounts(COMPANY);
    expect(JSON.stringify(accounts)).not.toContain("token-a");
    expect((await tokenStore.read(COMPANY, accounts[0]!.tokenRef))?.value).toContain("refresh-a");
  });
});