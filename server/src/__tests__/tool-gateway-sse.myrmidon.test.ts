import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

function createApp() {
  const toolGateway = {} as ToolGatewayService;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(toolGateway));
  const api = express.Router();
  api.use(toolGatewayRoutes({} as Db, toolGateway));
  app.use("/api", api);
  return { app, toolGateway };
}

const cases = [
  { name: "named gateway", path: "/mcp/gateways/gw-public-a", endpoint: "/mcp/gateways/gw-public-a" },
  {
    name: "tool gateway",
    path: "/api/tool-gateway/gateways/gateway-a/mcp",
    endpoint: "/api/tool-gateway/gateways/gateway-a/mcp",
  },
];

describe("MCP gateway GET with SSE Accept (myrmidon P10)", () => {
  for (const testCase of cases) {
    it(`answers 405 with Allow: POST for an SSE GET on the ${testCase.name} endpoint`, async () => {
      const { app } = createApp();
      const res = await request(app).get(testCase.path).set("Accept", "text/event-stream");
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("POST");
      expect(res.body).toEqual({ error: expect.stringContaining("POST") });
    });

    it(`answers 405 when text/event-stream is one of several accepted types on the ${testCase.name} endpoint`, async () => {
      const { app } = createApp();
      const res = await request(app).get(testCase.path).set("Accept", "application/json, Text/Event-Stream");
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("POST");
    });

    it(`keeps the vendor transport card for a plain GET on the ${testCase.name} endpoint`, async () => {
      const { app } = createApp();
      const res = await request(app).get(testCase.path).set("Accept", "application/json");
      expect(res.status).toBe(200);
      expect(res.headers.allow).toBeUndefined();
      expect(res.body).toEqual({
        transport: "streamable_http",
        endpoint: testCase.endpoint,
        authentication: "bearer",
      });
    });

    it(`keeps the vendor transport card for a GET without Accept on the ${testCase.name} endpoint`, async () => {
      const { app } = createApp();
      const res = await request(app).get(testCase.path);
      expect(res.status).toBe(200);
      expect(res.body.transport).toBe("streamable_http");
    });
  }

  it("does not answer 405 to a POST that also accepts SSE", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/mcp/gateways/gw-public-a")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).not.toBe(405);
  });
});
