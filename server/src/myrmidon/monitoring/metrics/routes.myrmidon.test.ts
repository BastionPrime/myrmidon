// myrmidon(1.7-METRICS): the endpoint contract, driven end to end through
// express with the token seams injected. The acceptance points of the ticket
// live here: 401 without/with a wrong token, the 0.0.4 content type, all
// families present, and the token precedence (company secret name over env).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  METRICS_TOKEN_ENV,
  METRICS_TOKEN_SECRET_ENV,
  myrmidonMetricsRoutes,
  resolveMetricsToken,
  tokenMatches,
} from "./routes.js";
import { METRIC_FAMILIES, METRICS_CONTENT_TYPE, type MetricsSnapshot } from "./metrics.js";

const TOKEN = "scraper-token-a";
const SECRET_TOKEN = "secret-token-a";
const NOW = new Date("2026-10-03T12:00:00.000Z");

describe("metrics endpoint routes", () => {
  function appWith(input: {
    env?: Record<string, string | undefined>;
    secretToken?: string | null;
  } = {}) {
    const env: Record<string, string | undefined> = {
      [METRICS_TOKEN_ENV]: TOKEN,
      ...input.env,
    };
    const secretToken = input.secretToken === undefined ? null : input.secretToken;
    const app = express();
    app.use(
      myrmidonMetricsRoutes({
        // The real DB half of the collector is covered by the embedded-pg
        // suite; the route tests run the guard and the response shape.
        db: {} as never,
        env: env as NodeJS.ProcessEnv,
        now: () => NOW,
        listSecretRowsByName: async (name) =>
          name === "metrics-scraper-token" ? [{ id: "secret-id-a", companyId: "company-a" }] : [],
        readSecretValue: async () => secretToken,
      }),
    );
    return app;
  }

  it("answers 401 when no token is configured (the endpoint never falls open)", async () => {
    const app = appWith({ env: { [METRICS_TOKEN_ENV]: undefined } });
    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("answers 401 without an Authorization header", async () => {
    const res = await request(appWith()).get("/metrics");
    expect(res.status).toBe(401);
  });

  it("answers 401 on a non-bearer Authorization header", async () => {
    const res = await request(appWith()).get("/metrics").set("Authorization", `Basic ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("answers 401 on a wrong bearer token", async () => {
    const res = await request(appWith()).get("/metrics").set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("answers 401 when the named company secret exists but resolves empty", async () => {
    const app = appWith({
      env: { [METRICS_TOKEN_ENV]: undefined, [METRICS_TOKEN_SECRET_ENV]: "metrics-scraper-token" },
      secretToken: null,
    });
    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("answers 200 with the 0.0.4 content type and every family for the right token", async () => {
    const res = await request(appWith()).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("version=0.0.4");
    for (const family of METRIC_FAMILIES) {
      expect(res.text, `family ${family}`).toContain(`# TYPE ${family} `);
      expect(res.text, `family ${family}`).toContain(`# HELP ${family} `);
    }
  });

  it("the company secret token wins over the env token", async () => {
    const app = appWith({
      env: { [METRICS_TOKEN_SECRET_ENV]: "metrics-scraper-token" },
      secretToken: SECRET_TOKEN,
    });
    const envTokenRes = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(envTokenRes.status).toBe(401);
    const secretTokenRes = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${SECRET_TOKEN}`);
    expect(secretTokenRes.status).toBe(200);
  });

  it("tokenMatches is constant-shape and length-strict", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokenMatches(TOKEN, "scraper-token-b")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });

  it("resolveMetricsToken reads the env token when no secret name is set", async () => {
    const token = await resolveMetricsToken({
      env: { [METRICS_TOKEN_ENV]: "env-token-a" } as NodeJS.ProcessEnv,
      listSecretRowsByName: async () => {
        throw new Error("no secret lookup expected on the env path");
      },
      readSecretValue: async () => {
        throw new Error("no secret value expected on the env path");
      },
    });
    expect(token).toBe("env-token-a");
  });

  it("resolveMetricsToken: a secret-lookup error falls back to the env token", async () => {
    const token = await resolveMetricsToken({
      env: {
        [METRICS_TOKEN_SECRET_ENV]: "metrics-scraper-token",
        [METRICS_TOKEN_ENV]: "env-token-a",
      } as NodeJS.ProcessEnv,
      listSecretRowsByName: async () => {
        throw new Error("database unavailable");
      },
      readSecretValue: async () => SECRET_TOKEN,
    });
    expect(token).toBe("env-token-a");
  });

  it("the snapshot contract keeps every family field", () => {
    const snapshot: MetricsSnapshot = {
      runsActive: 0,
      runsQueued: 0,
      runsFailedTotal: 0,
      runsFailedWindow: 0,
      runDurationSecondsP50: null,
      runDurationSecondsP95: null,
      roleQueueTasks: [],
      swarmClaimsActive: 0,
      swarmClaimsTotal: 0,
      agentErrorSignals: 0,
      llmCostCentsWindow: 0,
      scrapeErrors: 0,
      collectedAt: NOW.toISOString(),
    };
    expect(snapshot.collectedAt).toBe("2026-10-03T12:00:00.000Z");
  });
});
