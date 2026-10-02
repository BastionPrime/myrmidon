// server/src/myrmidon/ocr/backend.ts
//
// myrmidon(EXT-CASE-OCR): the two OCR contours a client company can name.
//
// The design note fixes the shape of the setting, not the shape of the call, so
// the call is behind one interface and two adapters:
//
//   - `ragflow` talks MCP JSON-RPC to a RAGFlow server (DeepDOC parsing) — the
//     same kind of endpoint `MYRMIDON_BOT_MCP_SERVERS` already hands to bots, so
//     a company that runs its own RAGFlow sets that address and keeps its data
//     in its own contour. The parse tool name is configuration (RAGFlow versions
//     name it differently), never hardcoded into a caller.
//   - `litellm` talks the OpenAI-compatible chat endpoint of the shared gateway
//     and sends the PDF as a file content part to a model that can read it.
//
// Both adapters take `fetch` as a dependency and never see the key: the key is
// passed in for the lifetime of one call, and no adapter puts it into a message
// or a log line. A backend failure is an `OcrError` with code `backend_failed`
// and the HTTP status, never the response body: bodies of a failing gateway can
// echo the request.

import { OcrError } from "./types.js";
import type { OcrBackendKind } from "./settings.js";

export interface OcrBackendRequest {
  /** Original file name, handed to the backend (it may use it for the result). */
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface OcrBackendResponse {
  /** Recognized text; empty when the backend recognized nothing. */
  text: string;
  /** Pages the backend counted, when it reports one. */
  pages: number | null;
}

export interface OcrBackend {
  readonly kind: OcrBackendKind;
  recognize(request: OcrBackendRequest): Promise<OcrBackendResponse>;
}

export interface OcrBackendDeps {
  fetch: typeof fetch;
  baseUrl: string;
  /** Read from the company's secrets for this call; never stored on the backend. */
  apiKey: string;
  /** Model (litellm) or MCP tool name (ragflow). */
  model: string | null;
  timeoutMs: number;
}

const MAX_PAGES_IN_RESPONSE = 100_000;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** `/v1/chat/completions` unless the configured address already ends with `/v1`. */
function litellmCompletionUrl(baseUrl: string): string {
  return /\/v1$/.test(baseUrl.replace(/\/+$/, ""))
    ? joinUrl(baseUrl, "/chat/completions")
    : joinUrl(baseUrl, "/v1/chat/completions");
}

function readPages(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PAGES_IN_RESPONSE) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed <= MAX_PAGES_IN_RESPONSE) return parsed;
  }
  return null;
}

/** The text of an OpenAI-style message content (a string, or text parts). */
function readChatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .filter((part) => part.length > 0);
    return parts.join("\n");
  }
  return "";
}

/** The text of an MCP tool result: possibly a JSON payload `{ text, pages }`. */
function readMcpResult(payload: unknown): OcrBackendResponse {
  const content = (payload as { content?: unknown } | null)?.content;
  const parts = Array.isArray(content) ? content : [];
  const text = parts
    .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .filter((part) => part.length > 0)
    .join("\n");
  if (!text) return { text: "", pages: null };
  try {
    const parsed = JSON.parse(text) as { text?: unknown; pages?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      return { text: parsed.text, pages: readPages(parsed.pages) };
    }
  } catch {
    // Not a JSON payload: the backend answered with the recognized text itself.
  }
  return { text, pages: null };
}

async function postJson(
  deps: OcrBackendDeps,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (error) {
    throw new OcrError(
      "backend_failed",
      `OCR backend is unreachable: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }
  if (!response.ok) {
    throw new OcrError("backend_failed", `OCR backend answered ${response.status}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new OcrError("backend_failed", "OCR backend answered with a body that is not JSON");
  }
}

const LITELLM_PROMPT =
  "Extract the full text of the attached PDF document. Keep the reading order and the line " +
  "breaks, keep headings, numbered lists, tables and dates as they are written. Return only " +
  "the recognized text, without comments or formatting marks.";

export function createLitellmBackend(deps: OcrBackendDeps): OcrBackend {
  return {
    kind: "litellm",
    async recognize(request) {
      const model = deps.model;
      if (!model) throw new OcrError("ocr_disabled", "OCR backend litellm requires a model (MYRMIDON_OCR_MODEL)");
      const payload = {
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: LITELLM_PROMPT },
              {
                type: "file",
                file: {
                  filename: request.name,
                  file_data: `data:${request.mimeType};base64,${Buffer.from(request.bytes).toString("base64")}`,
                },
              },
            ],
          },
        ],
      };
      const result = (await postJson(deps, litellmCompletionUrl(deps.baseUrl), payload)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const text = readChatText(result?.choices?.[0]?.message?.content);
      if (!text.trim()) throw new OcrError("empty_document", "OCR backend recognized no text");
      return { text, pages: null };
    },
  };
}

export function createRagflowBackend(deps: OcrBackendDeps): OcrBackend {
  const toolName = deps.model?.trim() || "parse_document";
  return {
    kind: "ragflow",
    async recognize(request) {
      const payload = {
        jsonrpc: "2.0",
        id: "ocr",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: {
            name: request.name,
            mime_type: request.mimeType,
            content_base64: Buffer.from(request.bytes).toString("base64"),
            parser: "deepdoc",
          },
        },
      };
      const result = await postJson(deps, deps.baseUrl, payload, { accept: "application/json" });
      const error = (result as { error?: { message?: unknown } } | null)?.error;
      if (error) {
        throw new OcrError(
          "backend_failed",
          `OCR backend answered an error: ${typeof error.message === "string" ? error.message : "unknown"}`,
        );
      }
      const parsed = readMcpResult((result as { result?: unknown } | null)?.result);
      if (!parsed.text.trim()) throw new OcrError("empty_document", "OCR backend recognized no text");
      return parsed;
    },
  };
}

/**
 * The backend the settings name. Returns null when a `litellm` contour has no
 * model: that is a configuration error, and the caller turns it into the same
 * stable "OCR is not configured" answer a bot already knows.
 */
export function createOcrBackend(
  settings: { backend: OcrBackendKind; baseUrl: string; model: string | null },
  deps: { fetch: typeof fetch; apiKey: string; timeoutMs: number },
): OcrBackend | null {
  const base = { fetch: deps.fetch, baseUrl: settings.baseUrl, apiKey: deps.apiKey, model: settings.model, timeoutMs: deps.timeoutMs };
  if (settings.backend === "litellm") {
    return settings.model ? createLitellmBackend(base) : null;
  }
  return createRagflowBackend(base);
}