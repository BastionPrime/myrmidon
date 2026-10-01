// myrmidon(EXT-CASE-OCR): the backend adapters, over a fake fetch.
//
// The two shapes the adapters send are pinned here: an OpenAI-compatible chat
// call with the PDF as a file part for `litellm`, an MCP `tools/call` for
// `ragflow`. The suite also pins what a failure looks like: a stable code plus
// the HTTP status, never the response body (a failing gateway can echo the
// request, and the request carries the company's key on the header).

import { describe, expect, it, vi } from "vitest";
import { createLitellmBackend, createOcrBackend, createRagflowBackend, type OcrBackendDeps } from "./backend.js";
import { OcrError } from "./types.js";

const PDF_BYTES = new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF\n", "latin1"));

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: () => Promise<Response>) {
  return vi.fn<FetchImpl>(impl);
}

function deps(fetchImpl: FetchImpl, overrides: Partial<OcrBackendDeps> = {}): OcrBackendDeps {
  return {
    fetch: fetchImpl,
    baseUrl: "http://ocr.example.com",
    apiKey: "company-key-value",
    model: null,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The error a call failed with; the suite checks its code and message. */
async function failure(promise: Promise<unknown>): Promise<OcrError> {
  try {
    await promise;
  } catch (error) {
    return error as OcrError;
  }
  throw new Error("expected the call to fail");
}

describe("litellm backend", () => {
  it("sends the document as a file content part to the chat endpoint", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "recognized text" } }] }));
    const backend = createLitellmBackend(deps(fetchImpl, { model: "ocr-model" }));
    const result = await backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES });

    expect(result.text).toBe("recognized text");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://ocr.example.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer company-key-value");
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: Array<{ type: string; file?: { filename: string; file_data: string } }> }>;
    };
    expect(body.model).toBe("ocr-model");
    const filePart = body.messages[0]!.content.find((part) => part.type === "file");
    expect(filePart?.file?.filename).toBe("tender.pdf");
    expect(filePart?.file?.file_data.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  it("does not duplicate /v1 when the address already ends with it", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const backend = createLitellmBackend(
      deps(fetchImpl, { baseUrl: "http://ocr.example.com/v1/", model: "ocr-model" }),
    );
    await backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://ocr.example.com/v1/chat/completions");
  });

  it("requires a model", async () => {
    const backend = createLitellmBackend(deps(vi.fn<FetchImpl>()));
    await expect(
      backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES }),
    ).rejects.toMatchObject({ code: "ocr_disabled" });
  });

  it("reports a failure with the status, never the body", async () => {
    const echoed = "upstream echoed: company-key-value";
    const fetchImpl = mockFetch(async () => new Response(echoed, { status: 502 }));
    const backend = createLitellmBackend(deps(fetchImpl, { model: "ocr-model" }));
    const error = await failure(
      backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES }),
    );
    expect(error).toBeInstanceOf(OcrError);
    expect(error.code).toBe("backend_failed");
    expect(error.message).toContain("502");
    expect(error.message).not.toContain("company-key-value");
  });

  it("reports an unreachable backend without echoing the request", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    });
    const backend = createLitellmBackend(deps(fetchImpl, { model: "ocr-model" }));
    await expect(
      backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES }),
    ).rejects.toMatchObject({ code: "backend_failed" });
  });
});

describe("ragflow backend", () => {
  it("calls the parse tool over MCP JSON-RPC with the default tool name", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ jsonrpc: "2.0", id: "ocr", result: { content: [{ type: "text", text: "recognized text" }] } }),
    );
    const backend = createRagflowBackend(deps(fetchImpl, { baseUrl: "http://ragflow.example.com/mcp" }));
    const result = await backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES });

    expect(result.text).toBe("recognized text");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://ragflow.example.com/mcp");
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: { name: string; arguments: { name: string; parser: string; content_base64: string } };
    };
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("parse_document");
    expect(body.params.arguments.name).toBe("tender.pdf");
    expect(body.params.arguments.parser).toBe("deepdoc");
  });

  it("takes the tool name from the model setting and reads a JSON payload", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({
        result: { content: [{ type: "text", text: JSON.stringify({ text: "payload text", pages: 3 }) }] },
      }),
    );
    const backend = createRagflowBackend(deps(fetchImpl, { model: "document.parse" }));
    const result = await backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES });
    expect(result).toEqual({ text: "payload text", pages: 3 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as { params: { name: string } };
    expect(body.params.name).toBe("document.parse");
  });

  it("reports a JSON-RPC error as a backend failure", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: { code: -32601, message: "no such tool" } }));
    const backend = createRagflowBackend(deps(fetchImpl));
    const error = await failure(
      backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES }),
    );
    expect(error.code).toBe("backend_failed");
    expect(error.message).toContain("no such tool");
  });

  it("reports an empty answer as an empty document", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ result: { content: [{ type: "text", text: "  " }] } }));
    const backend = createRagflowBackend(deps(fetchImpl));
    await expect(
      backend.recognize({ name: "tender.pdf", mimeType: "application/pdf", bytes: PDF_BYTES }),
    ).rejects.toMatchObject({ code: "empty_document" });
  });
});

describe("createOcrBackend", () => {
  it("builds the backend the settings name", () => {
    const fetchImpl = vi.fn<FetchImpl>();
    expect(
      createOcrBackend({ backend: "ragflow", baseUrl: "http://ocr.example.com", model: null }, {
        fetch: fetchImpl,
        apiKey: "k",
        timeoutMs: 1_000,
      })?.kind,
    ).toBe("ragflow");
    expect(
      createOcrBackend({ backend: "litellm", baseUrl: "http://ocr.example.com", model: "m" }, {
        fetch: fetchImpl,
        apiKey: "k",
        timeoutMs: 1_000,
      })?.kind,
    ).toBe("litellm");
  });

  it("answers null for a litellm contour without a model", () => {
    expect(
      createOcrBackend({ backend: "litellm", baseUrl: "http://ocr.example.com", model: null }, {
        fetch: vi.fn<FetchImpl>(),
        apiKey: "k",
        timeoutMs: 1_000,
      }),
    ).toBeNull();
  });
});