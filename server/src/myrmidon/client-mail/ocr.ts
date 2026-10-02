// server/src/myrmidon/client-mail/ocr.ts
//
// myrmidon(EXTCASE-M): the recognition step the mail pipeline calls.
//
// A PDF attachment goes to the OCR contour the deployment already names for the
// first third-party case — DeepDOC over RAGFlow, or an OCR model behind the LLM
// gateway — and what comes back is text. This is the same pair of contours the
// OCR path of the case uses (`server/src/myrmidon/ocr/`, EXTCASE-OCR); the mail
// module reads the same environment variables on purpose, so one deployment
// configures OCR once:
//
//   MYRMIDON_OCR_BASE_URL, MYRMIDON_OCR_KEY_SECRET, MYRMIDON_OCR_BACKEND,
//   MYRMIDON_OCR_MODEL, MYRMIDON_OCR_TIMEOUT_SEC
//
// It exists as its own small adapter because the mail pipeline must be buildable
// and testable on `main` before the OCR module lands: the port it fills is the
// same `recognize(companyId, input)` contract, and when the OCR module of the case
// is wired in this file goes away (see DIVERGENCE.md).
//
// Fail-closed when unset: an instance that never configured OCR gets a stable
// "not configured" answer and the message is still sorted — the mail path does
// not depend on recognition being available.
//
// The key is resolved per call from the company's secrets and is never stored on
// the adapter; a failed backend answers with its HTTP status, never with the
// response body, because a failing gateway can echo the request (which carries a
// client's document).

import type { ClientMailOcr } from "./pipeline.js";

export const OCR_BASE_URL_ENV = "MYRMIDON_OCR_BASE_URL";
export const OCR_KEY_SECRET_ENV = "MYRMIDON_OCR_KEY_SECRET";
export const OCR_BACKEND_ENV = "MYRMIDON_OCR_BACKEND";
export const OCR_MODEL_ENV = "MYRMIDON_OCR_MODEL";
export const OCR_TIMEOUT_SEC_ENV = "MYRMIDON_OCR_TIMEOUT_SEC";

export type OcrBackendKind = "ragflow" | "litellm";

export const DEFAULT_RAGFLOW_PARSE_TOOL = "parse_document";
export const DEFAULT_OCR_TIMEOUT_SEC = 120;

export interface ClientMailOcrSettings {
  /** Off unless an address and a key secret are both configured. */
  enabled: boolean;
  backend: OcrBackendKind;
  baseUrl: string | null;
  /** Name of the company secret holding the API key — never the key. */
  keySecret: string | null;
  model: string | null;
  timeoutMs: number;
}

export function readClientMailOcrSettings(env: NodeJS.ProcessEnv = process.env): ClientMailOcrSettings {
  const baseUrl = env[OCR_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[OCR_KEY_SECRET_ENV]?.trim() || null;
  const rawBackend = env[OCR_BACKEND_ENV]?.trim().toLowerCase();
  const backend: OcrBackendKind = rawBackend === "litellm" ? "litellm" : "ragflow";
  const rawTimeout = Number(env[OCR_TIMEOUT_SEC_ENV]?.trim());
  const timeoutSec =
    Number.isInteger(rawTimeout) && rawTimeout >= 5 && rawTimeout <= 600 ? rawTimeout : DEFAULT_OCR_TIMEOUT_SEC;
  return {
    enabled: Boolean(baseUrl && keySecret),
    backend,
    baseUrl,
    keySecret,
    model: env[OCR_MODEL_ENV]?.trim() || null,
    timeoutMs: timeoutSec * 1000,
  };
}

/** Why recognition cannot run, or null when it can. Names settings, never values. */
export function ocrSettingsProblem(settings: ClientMailOcrSettings): string | null {
  if (settings.baseUrl && settings.keySecret) return null;
  const missing = [
    settings.baseUrl ? null : OCR_BASE_URL_ENV,
    settings.keySecret ? null : OCR_KEY_SECRET_ENV,
  ].filter((name): name is string => name !== null);
  return `OCR is not configured on this instance: set ${missing.join(" and ")}`;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

export interface ClientMailOcrDeps {
  settings: ClientMailOcrSettings;
  fetch: typeof fetch;
  /** Reads the company secret named by the settings, for this call only. */
  readCompanyKey(companyId: string, secretName: string): Promise<string | null>;
}

/** The text of an OpenAI-style message content (a string, or text parts). */
function readChatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return "";
}

/** The text of an MCP tool result: possibly a JSON payload `{ text }`. */
function readMcpText(payload: unknown): string {
  const content = (payload as { content?: unknown } | null)?.content;
  const parts = Array.isArray(content) ? content : [];
  const text = parts
    .map((part) =>
      typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter((part) => part.length > 0)
    .join("\n");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { text?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") return parsed.text;
  } catch {
    // Not a JSON payload: the backend answered with the recognized text itself.
  }
  return text;
}

const LITELLM_PROMPT =
  "Extract the full text of the attached PDF document. Keep the reading order and the line " +
  "breaks, keep headings, numbered lists, tables and dates as they are written. Return only " +
  "the recognized text, without comments or formatting marks.";

/**
 * The recognition the mail pipeline calls. The result carries text only: the
 * caller writes it to the workspace and keeps it out of the journal.
 */
export function createClientMailOcr(deps: ClientMailOcrDeps): ClientMailOcr {
  return {
    async recognize(input) {
      const problem = ocrSettingsProblem(deps.settings);
      if (problem) throw new Error(problem);
      const apiKey = await deps.readCompanyKey(input.companyId, deps.settings.keySecret!);
      if (!apiKey) {
        throw new Error(`the OCR API key secret "${deps.settings.keySecret}" is not available to this company`);
      }
      const bytes = Buffer.from(input.bytes);
      const body =
        deps.settings.backend === "litellm"
          ? {
              model: deps.settings.model ?? "",
              temperature: 0,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: LITELLM_PROMPT },
                    {
                      type: "file",
                      file: { filename: input.name, file_data: `data:application/pdf;base64,${bytes.toString("base64")}` },
                    },
                  ],
                },
              ],
            }
          : {
              jsonrpc: "2.0",
              id: "ocr",
              method: "tools/call",
              params: {
                name: deps.settings.model?.trim() || DEFAULT_RAGFLOW_PARSE_TOOL,
                arguments: {
                  name: input.name,
                  mime_type: "application/pdf",
                  content_base64: bytes.toString("base64"),
                  parser: "deepdoc",
                },
              },
            };

      const url =
        deps.settings.backend === "litellm"
          ? /\/v1$/.test(deps.settings.baseUrl!.replace(/\/+$/, ""))
            ? joinUrl(deps.settings.baseUrl!, "/chat/completions")
            : joinUrl(deps.settings.baseUrl!, "/v1/chat/completions")
          : deps.settings.baseUrl!;

      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(deps.settings.timeoutMs),
        });
      } catch (error) {
        throw new Error(`the OCR backend is unreachable: ${error instanceof Error ? error.message : "request failed"}`);
      }
      if (!response.ok) throw new Error(`the OCR backend answered ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("the OCR backend answered with a body that is not JSON");
      }

      const text =
        deps.settings.backend === "litellm"
          ? readChatText(
              (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content,
            )
          : readMcpText((payload as { result?: unknown } | null)?.result);
      if (!text.trim()) throw new Error(`OCR recognized no text in "${input.name}"`);
      return { text };
    },
  };
}