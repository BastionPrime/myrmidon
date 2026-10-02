// myrmidon(EXT-CASE-OCR): the company OCR MCP endpoint.
//
// The endpoint runs over a fake runtime, so the suite tests the transport
// contract a bot speaks: initialize, tools/list, tools/call, and the two kinds
// of failure — a JSON-RPC error for an unknown method or tool, a tool result
// with `isError` for a recognition that did not succeed.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonOcrRoutes, type OcrRuntime } from "./index.js";
import { type OcrSettings } from "./settings.js";
import { OcrError, type OcrDocumentResult } from "./types.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};

const RESULT: OcrDocumentResult = {
  text: "recognized text",
  pages: 2,
  structure: { requirements: [], deadlines: [], positions: [] },
  metadata: {
    name: "tender.pdf",
    sizeBytes: 100,
    pages: 2,
    origin: "mail_attachment",
    sourceId: null,
    backend: "ragflow",
    chars: 15,
    truncated: false,
  },
};

const SETTINGS: OcrSettings = {
  enabled: true,
  backend: "ragflow",
  baseUrl: "http://ocr.example.com/mcp",
  keySecret: "ocr-key",
  model: null,
  maxBytes: 1024,
  maxPages: 500,
  maxChars: 100_000,
  timeoutMs: 120_000,
};

function harness(callTool: OcrRuntime["callTool"] = async () => RESULT) {
  const runtime: OcrRuntime = { settings: () => SETTINGS, recognize: vi.fn(), callTool };
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", myrmidonOcrRoutes({} as never, runtime));
    app.use(errorHandler);
    return app;
  };
  return { app: withActor(member), withActor, runtime };
}

const URL = `/api/myrmidon/companies/${COMPANY_ID}/ocr/mcp`;

describe("company OCR MCP endpoint", () => {
  it("answers initialize with the server identity", async () => {
    const { app } = harness();
    const res = await request(app).post(URL).send({ id: 1, method: "initialize" }).expect(200);
    expect(res.body.result.serverInfo.name).toBe("myrmidon-ocr");
    expect(res.body.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it("lists the ocr.pdf tool", async () => {
    const { app } = harness();
    const res = await request(app).post(URL).send({ id: 2, method: "tools/list" }).expect(200);
    expect(res.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ocr.pdf"]);
  });

  it("answers a notification with 202", async () => {
    const { app } = harness();
    await request(app).post(URL).send({ method: "notifications/initialized" }).expect(202);
  });

  it("runs the tool and returns the result as text and structured content", async () => {
    const callTool = vi.fn(async () => RESULT);
    const { app } = harness(callTool);
    const res = await request(app)
      .post(URL)
      .send({ id: 3, method: "tools/call", params: { name: "ocr.pdf", arguments: { name: "tender.pdf", base64: "AAAA" } } })
      .expect(200);

    expect(callTool).toHaveBeenCalledWith(COMPANY_ID, { name: "tender.pdf", base64: "AAAA" });
    expect(res.body.result.structuredContent.text).toBe("recognized text");
    expect(JSON.parse(res.body.result.content[0].text).metadata.name).toBe("tender.pdf");
  });

  it("answers an unknown method and an unknown tool with a JSON-RPC error", async () => {
    const { app } = harness();
    const method = await request(app).post(URL).send({ id: 4, method: "resources/list" }).expect(200);
    expect(method.body.error.code).toBe(-32601);

    const tool = await request(app)
      .post(URL)
      .send({ id: 5, method: "tools/call", params: { name: "mail.delta" } })
      .expect(200);
    expect(tool.body.error.code).toBe(-32602);
  });

  it("returns a failed recognition as a tool result with its code", async () => {
    const { app } = harness(async () => {
      throw new OcrError("not_a_pdf", '"tender.pdf" is not a PDF file');
    });
    const res = await request(app)
      .post(URL)
      .send({ id: 6, method: "tools/call", params: { name: "ocr.pdf", arguments: {} } })
      .expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent.code).toBe("not_a_pdf");
    expect(res.body.result.content[0].text).toContain("is not a PDF");
  });

  it("refuses a caller without access to the company", async () => {
    const { withActor } = harness();
    const outsider = { ...member, userId: "user-c", companyIds: [] };
    await request(withActor(outsider)).post(URL).send({ id: 7, method: "tools/list" }).expect(403);
  });
});