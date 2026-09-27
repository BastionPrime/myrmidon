import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

function createApp(listTools: () => Promise<unknown>) {
  const toolGateway = { listToolsForNamedGateway: listTools } as unknown as ToolGatewayService;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(toolGateway));
  const api = express.Router();
  api.use(toolGatewayRoutes({} as Db, toolGateway));
  app.use("/api", api);
  return app;
}

describe("MCP gateway protocol errors are JSON-RPC bodies (myrmidon P9)", () => {
  it("answers an unexpected error with HTTP 500 and a JSON-RPC internal error", async () => {
    const app = createApp(async () => {
      throw new Error("database connection lost");
    });
    const res = await request(app)
      .post("/mcp/gateways/gw-public-a")
      .set("authorization", "Bearer token-a")
      .send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "database connection lost", data: { reasonCode: "internal_error" } },
    });
  });

  it("keeps the HTTP status of an HttpError and carries its details", async () => {
    const app = createApp(async () => {
      throw new HttpError(409, "Gateway is being reconfigured", { gatewayId: "gateway-a" });
    });
    const res = await request(app)
      .post("/api/tool-gateway/gateways/gateway-a/mcp")
      .set("authorization", "Bearer token-a")
      .send({ jsonrpc: "2.0", id: "c", method: "tools/list" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      id: "c",
      error: {
        code: -32000,
        message: "Gateway is being reconfigured",
        data: { reasonCode: "http_error", status: 409, gatewayId: "gateway-a" },
      },
    });
  });

  it("maps a 5xx HttpError to -32603", async () => {
    const app = createApp(async () => {
      throw new HttpError(503, "Temporarily unavailable");
    });
    const res = await request(app)
      .post("/mcp/gateways/gw-public-a")
      .set("authorization", "Bearer token-a")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: -32603,
      message: "Temporarily unavailable",
      data: { reasonCode: "internal_error", status: 503 },
    });
  });

  it("keeps the vendor shape for gateway errors, the missing-bearer 401 and the SSE GET 405", async () => {
    const app = createApp(async () => {
      throw new ToolGatewayHttpError(403, "Denied", "tool_denied", { tool: "tool-a" });
    });
    const denied = await request(app)
      .post("/mcp/gateways/gw-public-a")
      .set("authorization", "Bearer token-a")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toEqual({ code: -32000, message: "Denied", data: { reasonCode: "tool_denied", tool: "tool-a" } });

    const missingBearer = await request(app)
      .post("/mcp/gateways/gw-public-a")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(missingBearer.status).toBe(401);
    expect(missingBearer.body).toEqual({ error: "Bearer token is required" });

    const sse = await request(app).get("/mcp/gateways/gw-public-a").set("accept", "text/event-stream");
    expect(sse.status).toBe(405);
    expect(sse.headers.allow).toBe("POST");
  });
});
