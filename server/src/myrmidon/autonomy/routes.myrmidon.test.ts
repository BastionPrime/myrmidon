// myrmidon(1.6-AUTONOMY): the autonomy routes and the enforcement gate.
//
// Two acceptance criteria meet here:
//   1. an agent caller whose instructions demand a forbidden action is still
//      refused — the gate answers 403 with a stable code, and no route work runs;
//   2. the matrix and the regulations are editable over the API with a change log.
//
// The router is the real one; the service runs the real domain code over an
// in-memory store with a recording activity sink. No database, no keys.
//
// Neutral data only: agent-a, company-a, example.com.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AUTONOMY_SAFE_DEFAULTS, type AutonomyChangeLogEntry } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { autonomyRoutes } from "./routes.js";
import { autonomyGate, AUTONOMY_FORBIDDEN_CODE } from "./gate.js";
import { memoryAutonomyStore } from "./store.js";
import { autonomyService, AUTONOMY_ACTIVITY_SOURCE } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const boardActor = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
  companyIds: [COMPANY_ID],
};

function makeChangeLog() {
  const rows: AutonomyChangeLogEntry[] = [];
  return {
    rows,
    logActivity: vi.fn(async (input: Parameters<Parameters<typeof autonomyService>[0]["logActivity"]>[0]) => {
      rows.push({
        id: `log-${rows.length + 1}`,
        at: "2026-10-02T00:00:00.000Z",
        actor: { type: input.actorType === "agent" ? "agent" : input.actorType === "system" ? "system" : "board", id: input.actorId },
        action: input.action.slice(`${AUTONOMY_ACTIVITY_SOURCE}.`.length) as AutonomyChangeLogEntry["action"],
        summary: String(input.details.summary ?? ""),
        matrixVersion: typeof input.details.matrixVersion === "number" ? input.details.matrixVersion : null,
        regulationId: typeof input.details.regulationId === "string" ? input.details.regulationId : null,
      });
    }),
    // Newest first, matching the production change log (dbAutonomyChangeLog orders desc).
    listChangeLog: async (_companyId: string, limit: number) => [...rows].reverse().slice(0, limit),
  };
}

function app(actor: unknown, store = memoryAutonomyStore()) {
  const changelog = makeChangeLog();
  let seq = 0;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    autonomyRoutes({
      store,
      listChangeLog: changelog.listChangeLog,
      logActivity: changelog.logActivity,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
      newId: () => `id-${++seq}`,
    }),
  );
  server.use(errorHandler);
  return { server, store, changelog };
}

/** A tiny express app that proves the gate stops a handler. */
function gatedApp(actor: unknown, verdictRole = "engineer") {
  const store = memoryAutonomyStore({
    version: 1,
    matrix: {
      version: 2,
      rules: [{ role: verdictRole, actionClass: "pause_wake_agents", verdict: "forbidden" }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    },
    regulations: [],
  });
  const gate = autonomyGate({ store, roleOf: async () => verdictRole });
  const ran = vi.fn();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.post("/api/agents/:id/pause", async (req, res, next) => {
    try {
      await gate.assertAllowed(req, "pause_wake_agents");
      ran();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  server.use(errorHandler);
  return { server, ran };
}

describe("myrmidon(1.6-AUTONOMY) gate: instruction-independent enforcement", () => {
  it("refuses a forbidden action for an agent caller with 403 and does not run the handler", async () => {
    const { server, ran } = gatedApp(agentActor);
    const res = await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(403);
    expect(res.body.code).toBe(AUTONOMY_FORBIDDEN_CODE);
    expect(res.body.details?.actionClass).toBe("pause_wake_agents");
    expect(ran).not.toHaveBeenCalled();
  });

  it("lets a board caller through even when the agent row is forbidden", async () => {
    const { server, ran } = gatedApp(boardActor);
    await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("lets an allowed agent caller through", async () => {
    const store = memoryAutonomyStore({
      version: 1,
      matrix: {
        version: 2,
        rules: [{ role: "engineer", actionClass: "pause_wake_agents", verdict: "allowed" }],
        defaults: { ...AUTONOMY_SAFE_DEFAULTS },
      },
      regulations: [],
    });
    const gate = autonomyGate({ store, roleOf: async () => "engineer" });
    const ran = vi.fn();
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = agentActor;
      next();
    });
    server.post("/api/agents/:id/pause", async (req, res, next) => {
      try {
        await gate.assertAllowed(req, "pause_wake_agents");
        ran();
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    server.use(errorHandler);
    await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("holds (does not refuse) an approval_required action and reports the verdict to the caller", async () => {
    const store = memoryAutonomyStore({
      version: 1,
      matrix: {
        version: 2,
        rules: [{ role: "engineer", actionClass: "merge", verdict: "approval_required" }],
        defaults: { ...AUTONOMY_SAFE_DEFAULTS },
      },
      regulations: [],
    });
    const gate = autonomyGate({ store, roleOf: async () => "engineer" });
    const decision = await gate.decide({ actor: agentActor } as never, "merge");
    expect(decision.verdict).toBe("approval_required");
    expect(decision.role).toBe("engineer");
  });
});

describe("myrmidon(1.6-AUTONOMY) routes: read and edit with a change log", () => {
  it("returns the safe default matrix, no regulations and an empty change log for a fresh company", async () => {
    const { server } = app(boardActor);
    const res = await request(server).get(`/api/myrmidon/autonomy?companyId=${COMPANY_ID}`).expect(200);
    expect(res.body.matrix.version).toBe(1);
    expect(res.body.matrix.rules).toEqual([]);
    expect(res.body.matrix.defaults).toEqual(AUTONOMY_SAFE_DEFAULTS);
    expect(res.body.regulations).toEqual([]);
    expect(res.body.changeLog).toEqual([]);
  });

  it("edits the matrix, answers 409 on a stale version and shows the edit in the change log", async () => {
    const { server } = app(boardActor);
    const patch = {
      expectedVersion: 1,
      rules: [{ role: "engineer", actionClass: "merge", verdict: "approval_required" }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    };
    const updated = await request(server).patch("/api/myrmidon/autonomy/matrix").send(patch).expect(200);
    expect(updated.body.matrix.version).toBe(2);

    const stale = await request(server).patch("/api/myrmidon/autonomy/matrix").send(patch).expect(409);
    expect(stale.body.code).toBe("autonomy_version_conflict");
    expect(stale.body.actualVersion).toBe(2);

    const snapshot = await request(server).get(`/api/myrmidon/autonomy?companyId=${COMPANY_ID}`).expect(200);
    expect(snapshot.body.changeLog).toHaveLength(1);
    expect(snapshot.body.changeLog[0].action).toBe("matrix_edit");
    expect(snapshot.body.changeLog[0].matrixVersion).toBe(2);
  });

  it("refuses a matrix edit from an agent caller", async () => {
    const { server } = app(agentActor);
    await request(server)
      .patch("/api/myrmidon/autonomy/matrix")
      .send({ rules: [], defaults: { ...AUTONOMY_SAFE_DEFAULTS } })
      .expect(403);
  });

  it("walks a regulation through create → edit → approve → restore and logs every step", async () => {
    const { server } = app(boardActor);
    const created = await request(server)
      .post("/api/myrmidon/autonomy/regulations")
      .send({ role: "engineer", title: "Engineering conduct", bodyMarkdown: "Ask before merging." })
      .expect(201);
    const id = created.body.regulation.id as string;
    expect(created.body.regulation.status).toBe("draft");

    const edited = await request(server)
      .patch(`/api/myrmidon/autonomy/regulations/${id}`)
      .send({ bodyMarkdown: "Ask before merging and before deploying." })
      .expect(200);
    expect(edited.body.regulation.revision).toBe(2);

    const approved = await request(server).post(`/api/myrmidon/autonomy/regulations/${id}/approve`).expect(200);
    expect(approved.body.regulation.status).toBe("approved");

    const restored = await request(server)
      .post(`/api/myrmidon/autonomy/regulations/${id}/revisions/1/restore`)
      .expect(200);
    expect(restored.body.regulation.bodyMarkdown).toBe("Ask before merging.");

    const snapshot = await request(server).get(`/api/myrmidon/autonomy?companyId=${COMPANY_ID}`).expect(200);
    expect(snapshot.body.regulations).toHaveLength(1);
    expect(snapshot.body.changeLog.map((row: { action: string }) => row.action)).toEqual([
      "regulation_rolled_back",
      "regulation_approved",
      "regulation_edited",
      "regulation_created",
    ]);
  });

  it("answers 404 for an unknown regulation and 403 for an agent caller", async () => {
    const board = app(boardActor);
    await request(board.server).post("/api/myrmidon/autonomy/regulations/nope/approve").expect(404);

    const agent = app(agentActor);
    await request(agent.server)
      .post("/api/myrmidon/autonomy/regulations")
      .send({ role: "engineer", title: "T", bodyMarkdown: "b" })
      .expect(403);
  });

  it("asks for the company when the caller has no single membership", async () => {
    const ambiguous = { ...boardActor, companyIds: [] };
    const { server } = app(ambiguous);
    await request(server).get("/api/myrmidon/autonomy").expect(422);
  });

  it("rejects a malformed matrix payload with 400", async () => {
    const { server } = app(boardActor);
    await request(server)
      .patch("/api/myrmidon/autonomy/matrix")
      .send({ rules: [{ role: "engineer", actionClass: "not-a-class", verdict: "allowed" }], defaults: {} })
      .expect(400);
  });
});