import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { boardKeyScopeMiddleware } from "../middleware/board-key-scope.js";

function appFor(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", boardKeyScopeMiddleware());
  app.use("/api", (req, res) => {
    res.json({ ok: true, path: req.path, method: req.method });
  });
  // minimal error shape mirroring the app's errorHandler contract
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

const boardKeyActor = (scope: any) => ({
  type: "board",
  userId: "user-1",
  source: "board_key",
  keyId: "key-1",
  boardKeyScope: scope,
});

describe("boardKeyScopeMiddleware (myrmidon ROLE-SCOPED-TOKENS)", () => {
  it("lets non-board-key actors through untouched", async () => {
    const app = appFor({ type: "board", userId: "user-1", source: "session" });
    const res = await request(app).post("/api/companies/1/agents");
    expect(res.status).toBe(200);
  });

  it("lets agent actors through untouched", async () => {
    const app = appFor({ type: "agent", agentId: "a-1", source: "agent_key" });
    const res = await request(app).post("/api/issues");
    expect(res.status).toBe(200);
  });

  it("full-scope and scopeless board keys mutate freely", async () => {
    for (const scope of [undefined, { kind: "full" }]) {
      const app = appFor(boardKeyActor(scope));
      const res = await request(app).delete("/api/companies/1/agents/9");
      expect(res.status).toBe(200);
    }
  });

  it("read_only board key: GET passes, POST is rejected 403 with scope reason", async () => {
    const app = appFor(boardKeyActor({ kind: "read_only" }));
    const get = await request(app).get("/api/companies/1/issues");
    expect(get.status).toBe(200);
    const post = await request(app).post("/api/companies/1/issues");
    expect(post.status).toBe(403);
    expect(post.body.error).toContain("read_only");
  });

  it("secrets_manage board key can rotate a secret but cannot create agents", async () => {
    const app = appFor(boardKeyActor({ kind: "secrets_manage" }));
    const rotate = await request(app).post("/api/secrets/1/rotate");
    expect(rotate.status).toBe(200);
    const createAgent = await request(app).post("/api/companies/1/agents");
    expect(createAgent.status).toBe(403);
  });

  it("agents_manage board key can wake agents but cannot touch secrets", async () => {
    const app = appFor(boardKeyActor({ kind: "agents_manage" }));
    const wake = await request(app).post("/api/companies/1/agents/9/wake");
    expect(wake.status).toBe(200);
    const rot = await request(app).post("/api/secrets/1/rotate");
    expect(rot.status).toBe(403);
  });

  it("release board key can mutate issues but not agents", async () => {
    const app = appFor(boardKeyActor({ kind: "release" }));
    const mutate = await request(app).patch("/api/companies/1/issues/5");
    expect(mutate.status).toBe(200);
    const agent = await request(app).post("/api/companies/1/agents");
    expect(agent.status).toBe(403);
  });

  it("ops board key can enter maintenance but cannot mutate issues", async () => {
    const app = appFor(boardKeyActor({ kind: "ops" }));
    const maint = await request(app).post("/api/health/maintenance");
    expect(maint.status).toBe(200);
    const issue = await request(app).post("/api/companies/1/issues");
    expect(issue.status).toBe(403);
  });
});
