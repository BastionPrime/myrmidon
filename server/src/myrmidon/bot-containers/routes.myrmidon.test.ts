// myrmidon(W2b): status and "Apply now" routes behind the agent card's Container section.
// Plain fakes for the database, the permission check, the driver and maintenance;
// the real applyBotContainerNow and reconcileBot run underneath.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { forbidden } from "../../errors.js";
import { errorHandler } from "../../middleware/index.js";
import { BOT_CONTAINERS_ENV, CONTAINER_GROUP_UNSUPPORTED_REASON } from "./agent-config.js";
import { BOT_IMAGE_ALLOWLIST_ENV } from "./docker-driver.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import { applyBotContainerNow, type BotContainerRuntimeDeps } from "./index.js";
import { createBotKeyLock } from "./bot-key-lock.js";
import { botContainerRoutes, type BotContainerRouteAgent, type BotContainerRoutesDeps } from "./routes.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ENABLED_ENV = { [BOT_CONTAINERS_ENV]: "1", [BOT_IMAGE_ALLOWLIST_ENV]: "bot-image:*, other/bot-image:1" };

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: ["other-company"] };
const viewer = {
  ...member,
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "viewer" }],
};
const agentActor = { type: "agent", source: "agent_key", agentId: AGENT_ID, companyId: COMPANY_ID, keyId: "key-a" };

function card(container: Record<string, unknown> | undefined, overrides: Partial<BotContainerRouteAgent> = {}): BotContainerRouteAgent {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    adapterType: "hermes_gateway",
    adapterConfig: container ? { container } : {},
    ...overrides,
  };
}

const ENABLED_CARD = { enabled: true, image: "bot-image:1.1.0", memoryMb: 2048, cpus: 1, pidsLimit: 512 };

function fakeDriver(overrides: Partial<BotContainerDriver> = {}): BotContainerDriver {
  return {
    status: async (botKey): Promise<BotContainerStatus> => ({ botKey, state: "running", image: "bot-image:1.1.0", restartHash: "r", filesHash: "f" }),
    list: async () => [],
    templateDrift: async () => false,
    create: async () => {},
    recreate: async () => {},
    writeProfile: async () => {},
    start: async () => {},
    restart: async () => {},
    stop: async () => {},
    ...overrides,
  };
}

function runtime(driver: BotContainerDriver): BotContainerRuntimeDeps {
  return {
    driver,
    compile: async (_agentId, botKey) => ({ botKey, files: [], restartHash: "r", filesHash: "f" }),
    maintenance: {
      enter: async () => ({ state: "on" as const, runningRuns: 0, owned: true }),
      status: async () => ({ state: "on" as const, runningRuns: 0 }),
      exit: async () => {},
    },
    network: "myrmidon-bots",
    lock: createBotKeyLock(),
  };
}

function app(actor: unknown, deps: Partial<BotContainerRoutesDeps> & { agent?: BotContainerRouteAgent | null }) {
  const { agent = card(ENABLED_CARD), ...rest } = deps;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    botContainerRoutes({
      getAgent: async (id) => (agent && id === agent.id ? agent : null),
      getRuntime: () => null,
      applyNow: applyBotContainerNow,
      env: ENABLED_ENV,
      ...rest,
    }),
  );
  server.use(errorHandler);
  return server;
}

const statusUrl = `/api/myrmidon/agents/${AGENT_ID}/bot-container/status`;
const applyUrl = `/api/myrmidon/agents/${AGENT_ID}/bot-container/apply`;

describe("myrmidon(W2b) bot container routes: access", () => {
  it("answers 404 for an unknown agent and for another company's agent, alike", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const unknown = await request(app(member, {})).get(`/api/myrmidon/agents/${other}/bot-container/status`).expect(404);
    const foreign = await request(app(outsider, {})).get(statusUrl).expect(404);
    expect(foreign.body).toEqual(unknown.body);
    await request(app(outsider, {})).post(applyUrl).expect(404);
  });

  it("refuses agent actors: an agent never restarts its own gateway", async () => {
    const applyNow = vi.fn();
    await request(app(agentActor, { applyNow })).get(statusUrl).expect(403);
    await request(app(agentActor, { applyNow })).post(applyUrl).expect(403);
    expect(applyNow).not.toHaveBeenCalled();
  });

  it("lets a read-only member see the status but not apply", async () => {
    const applyNow = vi.fn();
    await request(app(viewer, { applyNow, getRuntime: () => runtime(fakeDriver()) })).get(statusUrl).expect(200);
    await request(app(viewer, { applyNow, getRuntime: () => runtime(fakeDriver()) })).post(applyUrl).expect(403);
    expect(applyNow).not.toHaveBeenCalled();
  });

  it("applies the card configuration permission on apply only", async () => {
    const applyNow = vi.fn();
    const assertCanUpdateAgent = vi.fn(async () => {
      throw forbidden("No permission to change this agent");
    });
    const deps = { applyNow, assertCanUpdateAgent, getRuntime: () => runtime(fakeDriver()) };
    await request(app(member, deps)).get(statusUrl).expect(200);
    const denied = await request(app(member, deps)).post(applyUrl).expect(403);
    expect(denied.body.error).toBe("No permission to change this agent");
    expect(applyNow).not.toHaveBeenCalled();
  });
});

describe("myrmidon(W2b) bot container routes: MYRMIDON_BOT_CONTAINERS off", () => {
  const off = { env: { [BOT_IMAGE_ALLOWLIST_ENV]: "bot-image:*" } };

  it("reports the flag off and never asks the runtime", async () => {
    const status = vi.fn(async (botKey: string): Promise<BotContainerStatus> => ({ botKey, state: "running" }));
    const res = await request(app(member, { ...off, getRuntime: () => runtime(fakeDriver({ status })) })).get(statusUrl).expect(200);
    expect(res.body).toMatchObject({ enabled: false, runtimeConfigured: true, eligible: true, container: null, containerError: null });
    expect(status).not.toHaveBeenCalled();
  });

  it("refuses apply with 409 and does not reconcile", async () => {
    const applyNow = vi.fn();
    const res = await request(app(member, { ...off, applyNow, getRuntime: () => runtime(fakeDriver()) })).post(applyUrl).expect(409);
    expect(res.body).toMatchObject({ code: "bot_containers_disabled" });
    expect(applyNow).not.toHaveBeenCalled();
  });
});

describe("myrmidon(W2b) bot container routes: status", () => {
  it("returns the live container and the image allowlist verdict", async () => {
    const res = await request(app(member, { getRuntime: () => runtime(fakeDriver()) })).get(statusUrl).expect(200);
    expect(res.body).toEqual({
      enabled: true,
      runtimeConfigured: true,
      eligible: true,
      reason: null,
      imageAllowlist: ["bot-image:*", "other/bot-image:1"],
      imageAllowed: true,
      container: { state: "running", image: "bot-image:1.1.0" },
      containerError: null,
    });
    // No profile hashes leave the server.
    expect(JSON.stringify(res.body)).not.toContain("restartHash");
  });

  it("flags an image outside the allowlist", async () => {
    const agent = card({ ...ENABLED_CARD, image: "untrusted/image:latest" });
    const res = await request(app(member, { agent, getRuntime: () => runtime(fakeDriver()) })).get(statusUrl).expect(200);
    expect(res.body).toMatchObject({ eligible: true, imageAllowed: false });
  });

  it("without a wired runtime: no container query, runtimeConfigured false", async () => {
    const res = await request(app(member, {})).get(statusUrl).expect(200);
    expect(res.body).toMatchObject({ enabled: true, runtimeConfigured: false, container: null, containerError: null });
  });

  it("still asks for the container of a card that is switched off", async () => {
    const agent = card({ ...ENABLED_CARD, enabled: false });
    const res = await request(app(member, { agent, getRuntime: () => runtime(fakeDriver()) })).get(statusUrl).expect(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toContain("enabled");
    expect(res.body.container).toEqual({ state: "running", image: "bot-image:1.1.0" });
  });

  it("does not ask the runtime about agents that are not hermes_gateway", async () => {
    const status = vi.fn(async (botKey: string): Promise<BotContainerStatus> => ({ botKey, state: "running" }));
    const agent = card(ENABLED_CARD, { adapterType: "hermes_local" });
    const res = await request(app(member, { agent, getRuntime: () => runtime(fakeDriver({ status })) })).get(statusUrl).expect(200);
    expect(res.body).toMatchObject({ eligible: false, imageAllowed: null, container: null });
    expect(res.body.reason).toContain("hermes_gateway");
    expect(status).not.toHaveBeenCalled();
  });

  it("reports a missing container as state missing", async () => {
    const driver = fakeDriver({ status: async (botKey) => ({ botKey, state: "missing" }) });
    const res = await request(app(member, { getRuntime: () => runtime(driver) })).get(statusUrl).expect(200);
    expect(res.body.container).toEqual({ state: "missing", image: null });
  });

  it("reports a runtime failure without leaking its message", async () => {
    const driver = fakeDriver({
      status: async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      },
    });
    const res = await request(app(member, { getRuntime: () => runtime(driver) })).get(statusUrl).expect(200);
    expect(res.body.container).toBeNull();
    expect(res.body.containerError).toBe("The container runtime did not answer.");
    expect(JSON.stringify(res.body)).not.toContain("docker.sock");
  });
});

describe("myrmidon(W2b) bot container routes: apply", () => {
  it("creates the container from the saved card and reports the outcome", async () => {
    const create = vi.fn(async () => {});
    const writeProfile = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const driver = fakeDriver({
      status: async (botKey) => ({ botKey, state: "missing" }),
      create,
      writeProfile,
      start,
    });
    const res = await request(app(member, { getRuntime: () => runtime(driver) })).post(applyUrl).expect(200);
    expect(res.body).toEqual({ outcome: { kind: "created" } });
    expect(create).toHaveBeenCalledWith({
      botKey: AGENT_ID,
      image: "bot-image:1.1.0",
      memoryMb: 2048,
      cpus: 1,
      pidsLimit: 512,
      network: "myrmidon-bots",
    });
    expect(writeProfile).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(AGENT_ID);
  });

  it("reports an already applied card as unchanged", async () => {
    const res = await request(app(member, { getRuntime: () => runtime(fakeDriver()) })).post(applyUrl).expect(200);
    expect(res.body).toEqual({ outcome: { kind: "unchanged" } });
  });

  it("answers 503 while the instance has no container runtime", async () => {
    const applyNow = vi.fn();
    const res = await request(app(member, { applyNow })).post(applyUrl).expect(503);
    expect(res.body).toMatchObject({ code: "bot_container_runtime_unavailable" });
    expect(applyNow).not.toHaveBeenCalled();
  });

  it("answers 409 with the reason for a card that is not applicable", async () => {
    const driver = fakeDriver({
      status: async () => {
        throw new Error("the driver must not be called for a card that is not applicable");
      },
    });
    const off = await request(app(member, { agent: card({ ...ENABLED_CARD, enabled: false }), getRuntime: () => runtime(driver) }))
      .post(applyUrl)
      .expect(409);
    expect(off.body).toMatchObject({ code: "bot_container_not_applicable" });
    expect(off.body.error).toContain("enabled");

    const other = await request(app(member, { agent: card(ENABLED_CARD, { adapterType: "hermes_local" }), getRuntime: () => runtime(driver) }))
      .post(applyUrl)
      .expect(409);
    expect(other.body.error).toContain("hermes_gateway");
  });

  it("refuses a shared container group as not applicable", async () => {
    const res = await request(app(member, { agent: card({ ...ENABLED_CARD, group: "team-b" }), getRuntime: () => runtime(fakeDriver()) }))
      .post(applyUrl)
      .expect(409);
    expect(res.body.error).toBe(CONTAINER_GROUP_UNSUPPORTED_REASON);
  });

  it("answers 502 with the failure when the reconcile fails", async () => {
    const driver = fakeDriver({
      status: async (botKey) => ({ botKey, state: "missing" }),
      create: async () => {
        throw new Error('image "bot-image:1.1.0" is not in MYRMIDON_BOT_IMAGE_ALLOWLIST');
      },
    });
    const res = await request(app(member, { getRuntime: () => runtime(driver) })).post(applyUrl).expect(502);
    const message = 'image "bot-image:1.1.0" is not in MYRMIDON_BOT_IMAGE_ALLOWLIST';
    expect(res.body).toEqual({ error: message, outcome: { kind: "error", message } });
  });

  it("clips a very long failure message", async () => {
    const driver = fakeDriver({
      status: async () => {
        throw new Error("x".repeat(2000));
      },
    });
    const res = await request(app(member, { getRuntime: () => runtime(driver) })).post(applyUrl).expect(502);
    expect(res.body.outcome.message.length).toBeLessThanOrEqual(501);
  });
});
