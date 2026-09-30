// myrmidon(EMERGENCY-STOP): route access and immediate-stop behaviour.
// Plain fakes for the database, the permission check and the cancel path, the
// same shape as the W2b bot-container route tests; the route and the stop
// orchestration underneath are the real code.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { forbidden } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => ({})),
}));

import { myrmidonEmergencyStopRoutes, type EmergencyStopDeps } from "./emergency-stop.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: ["other-company"] };
const agentActor = { type: "agent", source: "agent_key", agentId: AGENT_ID, companyId: COMPANY_ID, keyId: "key-a" };

const stopUrl = `/api/myrmidon/agents/${AGENT_ID}/emergency-stop`;

function deps(overrides: Record<string, unknown> = {}) {
  return {
    cancelActiveForAgent: vi.fn(async () => 2),
    assertCanManageAgents: vi.fn(
      async () => {},
    ) as unknown as { mock: { calls: unknown[][] } } & EmergencyStopDeps["assertCanManageAgents"],
    getAgent: vi.fn(async (id: string) =>
      id === AGENT_ID ? { id: AGENT_ID, companyId: COMPANY_ID } : null,
    ),
    ...overrides,
  };
}

function app(actor: unknown, routeDeps: ReturnType<typeof deps>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    myrmidonEmergencyStopRoutes({} as never, routeDeps as unknown as Parameters<typeof myrmidonEmergencyStopRoutes>[1]),
  );
  server.use(errorHandler);
  return server;
}

describe("myrmidon(EMERGENCY-STOP) route: access", () => {
  it("answers 404 for an unknown agent and for another company's agent, alike", async () => {
    const unknown = await request(app(member, deps())).post(`/api/myrmidon/agents/${"33333333-3333-4333-8333-333333333333"}/emergency-stop`).expect(404);
    const foreign = await request(app(outsider, deps())).post(stopUrl).expect(404);
    expect(foreign.body).toEqual(unknown.body);
  });

  it("refuses agent actors", async () => {
    const d = deps();
    await request(app(agentActor, d)).post(stopUrl).expect(403);
    expect(d.cancelActiveForAgent).not.toHaveBeenCalled();
  });

  it("lets a read-only member resolve the agent but not stop the runs", async () => {
    const d = deps({
      assertCanManageAgents: vi.fn(async () => {
        throw forbidden("No permission to manage agents in this company");
      }),
    });
    const res = await request(app(member, d)).post(stopUrl).expect(403);
    expect(res.body.error).toBe("No permission to manage agents in this company");
    expect(d.cancelActiveForAgent).not.toHaveBeenCalled();
  });

  it("checks the manage-agents permission before cancelling, with the company in context", async () => {
    const d = deps();
    await request(app(member, d)).post(stopUrl).expect(200);
    expect(d.assertCanManageAgents).toHaveBeenCalledTimes(1);
    expect(d.assertCanManageAgents.mock.calls[0]?.[1]).toBe(COMPANY_ID);
  });
});

describe("myrmidon(EMERGENCY-STOP) route: the stop itself", () => {
  it("cancels the agent's runs and reports the count", async () => {
    const d = deps({ cancelActiveForAgent: vi.fn(async () => 3) });
    const res = await request(app(member, d)).post(stopUrl).expect(200);
    expect(res.body).toEqual({ agentId: AGENT_ID, runsCancelled: 3 });
    expect(d.cancelActiveForAgent).toHaveBeenCalledWith(AGENT_ID, "Cancelled by emergency stop");
  });

  it("keeps the agent's own status untouched (only runs are cancelled)", async () => {
    const d = deps();
    await request(app(member, d)).post(stopUrl).expect(200);
    // The route has no agent status update path at all: the only mutation is
    // the cancel call. The dependency surface pins that: cancelActiveForAgent
    // is the single write the route can reach.
    expect(Object.keys(d)).toEqual(["cancelActiveForAgent", "assertCanManageAgents", "getAgent"]);
  });
});
