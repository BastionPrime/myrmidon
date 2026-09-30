// myrmidon(R5-A) deploy jobs: the routes over the real service with fake
// ports, the same harness pattern the runtime-limits routes use.
//
// Pins: reads need board access; writes need instance admin; an agent token is
// refused everywhere; a malformed digest is a 400; the disabled feature is a
// 503 on create, not on read.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { deployJobsRoutes } from "./routes.js";
import { deployJobsService, type DeployJobServiceDeps } from "./service.js";
import { readDeployJobsSettings } from "./settings.js";
import { emptyDeployJobDocument, type DeployJobDocument } from "./domain.js";
import type { ProbeDeps } from "./registry.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CI_LABELS = {
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": "https://github.com/itkadr-git/myrmidon",
  "org.opencontainers.image.version": "2026.916.1-myr.1",
};

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function harness(options: { enabled?: boolean } = {}) {
  const doc: DeployJobDocument = emptyDeployJobDocument();
  const deps: DeployJobServiceDeps = {
    maintenance: {
      enter: vi.fn(async () => ({ id: "window-a", state: "entering" })),
      exit: vi.fn(async () => ({ state: "off" })),
      status: vi.fn(async () => ({ instance: null })),
    },
    readHostReport: async () => null,
    readHealth: async () => null,
    settings: { ...readDeployJobsSettings({}), enabled: options.enabled ?? true, tickMs: 60_000 },
    probes: {
      registryInspectUrl: "https://registry-inspect.example.com/inspect",
      fetchJson: async (url: string) => {
        if (url.startsWith("https://registry-inspect.example.com/")) return { config: { Labels: CI_LABELS } };
        if (url.includes("/compare/")) return { status: "ahead" };
        return [];
      },
    } satisfies ProbeDeps,
    logActivity: (async () => ({})) as unknown as DeployJobServiceDeps["logActivity"],
  };
  const store = {
    read: async () => structuredClone(doc),
    mutate: async <T>(change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T }) => {
      const { next, result } = change(doc);
      if (next) Object.assign(doc, next);
      return { doc, result, changed: next !== null };
    },
  };
  const service = deployJobsService(store as unknown as Db, deps);
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", deployJobsRoutes({} as Db, service));
    app.use(errorHandler);
    return app;
  };
  return { app: withActor(member), withActor };
}

const URL = "/api/myrmidon/deploy-jobs";

describe("deploy jobs routes", () => {
  it("lets a board member read the job state", async () => {
    const h = harness();
    const res = await request(h.app).get(URL).expect(200);
    expect(res.body).toEqual({ job: null, history: [] });
  });

  it("refuses an agent token on read and write", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(agentActor)).post(URL).send({ reference: GOOD }).expect(403);
  });

  it("lets a member read but not write; only an instance admin creates a job", async () => {
    const h = harness();
    await request(h.withActor(member)).post(URL).send({ reference: GOOD }).expect(403);
    const res = await request(h.withActor(admin)).post(URL).send({ reference: GOOD }).expect(201);
    expect(res.body.status).toBe("maintenance_entering");
    expect(res.body.digest).toBe(GOOD);
  });

  it("refuses a malformed digest with 400 before touching anything", async () => {
    const h = harness();
    await request(h.withActor(admin)).post(URL).send({ reference: "latest" }).expect(400);
    await request(h.withActor(admin)).post(`${URL}/preview`).send({ reference: "sha256:short" }).expect(400);
  });

  it("answers 503 on create when the feature is not enabled, but reads still work", async () => {
    const h = harness({ enabled: false });
    await request(h.app).get(URL).expect(200);
    await request(h.withActor(admin)).post(URL).send({ reference: GOOD }).expect(503);
  });

  it("preview verifies a CI image and changes nothing", async () => {
    const h = harness();
    const res = await request(h.withActor(member)).post(`${URL}/preview`).send({ reference: GOOD }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.commit).toBe(COMMIT);
    const current = await request(h.app).get(URL).expect(200);
    expect(current.body.job).toBeNull();
  });

  it("abort is admin-only and answers 404 for an unknown job", async () => {
    const h = harness();
    const jobId = "11111111-2222-4333-8444-555555555555";
    await request(h.withActor(member)).post(`${URL}/${jobId}/abort`).send({ id: jobId }).expect(403);
    await request(h.withActor(admin)).post(`${URL}/${jobId}/abort`).send({ id: jobId }).expect(404);
  });
});
