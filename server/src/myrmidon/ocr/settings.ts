// server/src/myrmidon/ocr/settings.ts
//
// myrmidon(EXT-CASE-OCR): where the OCR path gets its backend and its limits.
//
// The instance names the OCR contour once, in the same shape the per-bot MCP
// servers already use: an address, the *name* of the company secret that holds
// the key, and the extra fields the backend needs. The value of the key is never
// part of the setting — it is read from the company's secrets at call time, so
// the contour of one client company never leaks into another company's call, and
// an operator can rotate the key without touching the server configuration.
//
// Unset (the default) means the path is off: a bot asking for `ocr.pdf` gets a
// stable "not configured" error instead of a request to an address nobody set.

/** `ragflow` (DeepDOC parse over MCP) or `litellm` (a model behind the gateway). */
export const OCR_BACKEND_ENV = "MYRMIDON_OCR_BACKEND";
export const OCR_BASE_URL_ENV = "MYRMIDON_OCR_BASE_URL";
/** Name of the company secret holding the API key, not the key. */
export const OCR_KEY_SECRET_ENV = "MYRMIDON_OCR_KEY_SECRET";
/** Model for the `litellm` backend; the MCP tool name for the `ragflow` backend. */
export const OCR_MODEL_ENV = "MYRMIDON_OCR_MODEL";
export const OCR_MAX_BYTES_ENV = "MYRMIDON_OCR_MAX_BYTES";
export const OCR_MAX_PAGES_ENV = "MYRMIDON_OCR_MAX_PAGES";
export const OCR_MAX_CHARS_ENV = "MYRMIDON_OCR_MAX_CHARS";
export const OCR_TIMEOUT_SEC_ENV = "MYRMIDON_OCR_TIMEOUT_SEC";

export type OcrBackendKind = "ragflow" | "litellm";

export const DEFAULT_OCR_BACKEND: OcrBackendKind = "ragflow";
export const DEFAULT_OCR_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_OCR_MAX_PAGES = 500;
export const DEFAULT_OCR_MAX_CHARS = 2_000_000;
export const DEFAULT_OCR_TIMEOUT_SEC = 120;
/** The MCP tool a RAGFlow server is asked to parse a document with. */
export const DEFAULT_RAGFLOW_TOOL = "parse_document";

const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 600;

export interface OcrSettings {
  /** Off unless an address and a key secret are both configured. */
  enabled: boolean;
  backend: OcrBackendKind;
  /** Address of the OCR contour as the board reaches it. */
  baseUrl: string | null;
  /** Company secret name holding the API key. */
  keySecret: string | null;
  /** Model (litellm) or MCP tool name (ragflow); null means the backend's default. */
  model: string | null;
  maxBytes: number;
  maxPages: number;
  maxChars: number;
  timeoutMs: number;
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0 || value > max) return fallback;
  return value;
}

/**
 * The settings an instance runs the OCR path with.
 *
 * A value that is present but unusable (an unknown backend, a non-integer
 * limit) falls back to the default instead of disabling the path: an operator
 * typo in a limit must not silently switch OCR off. A missing address or key
 * secret is not a typo — that is the documented way to leave the path closed.
 */
export function readOcrSettings(env: NodeJS.ProcessEnv = process.env): OcrSettings {
  const baseUrl = env[OCR_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[OCR_KEY_SECRET_ENV]?.trim() || null;
  const rawBackend = env[OCR_BACKEND_ENV]?.trim().toLowerCase();
  const backend: OcrBackendKind =
    rawBackend === "litellm" || rawBackend === "ragflow" ? rawBackend : DEFAULT_OCR_BACKEND;
  const timeoutSec = readPositiveInt(env[OCR_TIMEOUT_SEC_ENV], DEFAULT_OCR_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
  return {
    enabled: Boolean(baseUrl && keySecret),
    backend,
    baseUrl,
    keySecret,
    model: env[OCR_MODEL_ENV]?.trim() || null,
    maxBytes: readPositiveInt(env[OCR_MAX_BYTES_ENV], DEFAULT_OCR_MAX_BYTES, Number.MAX_SAFE_INTEGER),
    maxPages: readPositiveInt(env[OCR_MAX_PAGES_ENV], DEFAULT_OCR_MAX_PAGES, Number.MAX_SAFE_INTEGER),
    maxChars: readPositiveInt(env[OCR_MAX_CHARS_ENV], DEFAULT_OCR_MAX_CHARS, Number.MAX_SAFE_INTEGER),
    timeoutMs: Math.max(timeoutSec, MIN_TIMEOUT_SEC) * 1000,
  };
}

/**
 * Why the path cannot serve a call, or null when it can. The message names the
 * settings, never a value, so it is safe to hand to a bot and to the journal.
 */
export function ocrSettingsProblem(settings: OcrSettings): string | null {
  if (settings.baseUrl && settings.keySecret) return null;
  const missing = [
    settings.baseUrl ? null : OCR_BASE_URL_ENV,
    settings.keySecret ? null : OCR_KEY_SECRET_ENV,
  ].filter((name): name is string => name !== null);
  return `OCR is not configured on this instance: set ${missing.join(" and ")}`;
}