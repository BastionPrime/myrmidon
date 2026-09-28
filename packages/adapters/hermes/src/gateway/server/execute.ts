import fs from "node:fs/promises";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  RuntimeStatusUpdate,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  STOP_GRACE_MS,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";
// myrmidon(G4): "┊"/"💭" line prefixes shared with hermes_local's stdout shape,
// so gateway/ui/parse-stdout.ts can hand ┊- and 💭-marked lines to the same
// local-adapter parser instead of duplicating tool/assistant/thinking parsing.
import { THINKING_PREFIX, TOOL_OUTPUT_PREFIX } from "../../shared/constants.js";
// myrmidon(G4): reuse the M1 card-model reader (adapterConfig.model/.effort/
// .models.reasoningEffort) instead of re-parsing the same fields here.
import { readHermesCardModels } from "../../server/myrmidon-profile-config.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type SseFrame = {
  event: string | null;
  data: string;
};

type HermesHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
};

type TerminalState = {
  runId: string;
  status: string;
  eventName?: string | null;
  payload?: Record<string, unknown> | null;
  output?: string | null;
};

type ExecutionState = {
  runId: string;
  outputChunks: string[];
  lastEventName: string | null;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
  /** myrmidon(G4): partial message.delta text not yet flushed as a "┊ 💬" line. */
  deltaLineBuffer: string;
  /** myrmidon(G4): FIFO queue (per tool name) of previews captured from
   * tool.started, popped by the matching tool.completed. The real gateway's
   * tool.completed payload never carries a preview/detail field itself
   * (api_server_runs.py's _FIXED_EVENT_FIELDS drops it — only tool.started
   * keeps one), matching how the vendor CLI's own completion-line renderer
   * (agent/display.py's _get_cute_tool_message) is handed the call's original
   * args, not anything from the completion event. See
   * formatCompactToolCompletedLine. */
  toolPreviews: Map<string, string[]>;
};

type TextRedactor = (value: string) => string;

const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;
const HERMES_SESSION_KEY_HEADER_PATTERN = /(X-Hermes-Session-Key\s*[:=]\s*)([^\s,;]+)/gi;
const PAPERCLIP_SESSION_KEY_PATTERN =
  /\bpaperclip:(?:company:[A-Za-z0-9-]+:agent:[A-Za-z0-9-]+(?::(?:issue|run):[A-Za-z0-9-]+)?|run:[A-Za-z0-9-]+)\b/gi;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

// myrmidon(G4): approval requests otherwise leave a run parked in
// waiting_for_approval until the adapter timeout; auto-deny keeps it moving.
const APPROVAL_REQUEST_EVENT = "approval.request";
const APPROVAL_DENY_CHOICE = "deny";

// myrmidon(G4): compact progress-log formatting, matching the shape
// agent/display.py's _get_cute_tool_message() fallback renderer writes
// (`┊ ⚡ {name:9} {preview}  {duration}s`) so gateway/ui/parse-stdout.ts can
// hand these lines to the shared parseHermesStdoutLine() parser.
const COMPACT_TOOL_NAME_WIDTH = 9;
const COMPACT_TOOL_PREVIEW_MAX_CHARS = 120;
const COMPACT_ASSISTANT_PREVIEW_MAX_CHARS = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
      url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
      HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
    ) {
      url.pathname = "/api";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(HERMES_SESSION_KEY_HEADER_PATTERN, "$1[redacted]")
    .replace(PAPERCLIP_SESSION_KEY_PATTERN, "[redacted-session-key]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({
      secret,
      regex: new RegExp(escapeRegExp(secret), "g"),
    }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0, redactText: TextRedactor = sanitizeSensitiveText): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]`
      : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function parseHeaders(value: unknown): Record<string, string> {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

function buildHeaders(input: {
  apiKey: string;
  sessionKey: string | null;
  runId: string;
  extraHeaders: Record<string, string>;
  accept: string;
  contentType?: string;
}): Record<string, string> {
  return {
    ...input.extraHeaders,
    Authorization: `Bearer ${input.apiKey}`,
    Accept: input.accept,
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    "Idempotency-Key": input.runId,
    ...(input.sessionKey ? { "X-Hermes-Session-Key": input.sessionKey } : {}),
  };
}

function buildInput(ctx: AdapterExecutionContext, paperclipApiUrl: string | null, idempotencyRunId: string): string {
  // Stable session keys (issue/agent strategy) resume the same remote Hermes
  // conversation across runs; a stored session id from a prior run means that
  // conversation already received the task brief, so pick the compact
  // task-context variant under the shared resume rules.
  const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const resumedSession =
    (sessionKeyStrategy === "issue" || sessionKeyStrategy === "agent") &&
    Boolean(nonEmpty(ctx.runtime?.sessionId));
  const taskMarkdown = nonEmpty(selectPaperclipTaskMarkdown(ctx.context, { resumedSession }));
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    conversationMode: ctx.context.conversationMode === true,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: Boolean(taskMarkdown),
  });
  const wakePayloadJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake, {
    omitIssueDescription: Boolean(taskMarkdown),
  });
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    // myrmidon(G4): the idempotency-stable id (retryOfRunId ?? ctx.runId), not
    // the raw per-attempt ctx.runId — see the idempotencyKey comment in
    // execute(). A process_lost retry's /v1/runs body must be byte-identical
    // to the attempt it is retrying (Hermes fingerprints the whole body:
    // api_server_runs.py's idempotency_fingerprint = sha256(body, ...)), or
    // the shared Idempotency-Key header gets a 409 conflict instead of
    // replayed:true. Using ctx.runId here would make every retry's body
    // differ from the original it is supposed to match.
    `- Run ID: ${idempotencyRunId}`,
    ...(paperclipApiUrl ? [`- Paperclip API URL: ${paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
    ...(ctx.context.conversationMode === true || isPaperclipRecoveryWakePayload(ctx.context.paperclipWake)
      ? []
      : [
          "Execution contract:",
          "- Take concrete action in this run when the task is actionable.",
          "- Do not stop at a plan unless the issue asks for planning only.",
          "- Leave durable progress and update the issue to a clear final disposition.",
          "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
          "",
        ]),
    wakePrompt,
    ...(sessionHandoff ? ["", sessionHandoff] : []),
    ...(taskMarkdown ? ["", taskMarkdown] : []),
    ...(wakePayloadJson
      ? [
          "",
          "Structured wake payload JSON:",
          "```json",
          wakePayloadJson,
          "```",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

// myrmidon(G4): translate the M1 reasoning-effort card field into the
// `model_options.reasoning.effort` shape /v1/runs accepts (api_server.py's
// _request_reasoning_config); hermes itself ignores an effort it does not
// recognize, so this does not duplicate HERMES_REASONING_EFFORTS validation.
function buildModelOptions(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const { reasoningEffort } = readHermesCardModels(config);
  return reasoningEffort ? { reasoning: { effort: reasoningEffort } } : undefined;
}

function buildRunBody(
  ctx: AdapterExecutionContext,
  sessionKey: string | null,
  agentInstructionsBundle: string,
  idempotencyRunId: string,
): Record<string, unknown> {
  const paperclipApiUrl = nonEmpty(ctx.config.paperclipApiUrl);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const configuredInput = nonEmpty(payloadTemplate.input);
  const input = configuredInput && ctx.context.conversationMode === true
    ? `${configuredInput}\n\n${buildInput(ctx, paperclipApiUrl, idempotencyRunId)}`
    : configuredInput ?? buildInput(ctx, paperclipApiUrl, idempotencyRunId);
  const cardInstructions =
    nonEmpty(ctx.config.instructions) ??
    nonEmpty(payloadTemplate.instructions) ??
    "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";
  // myrmidon(G4): prepend the Paperclip-managed instructions bundle (the same
  // file hermes_local injects via instructionsFilePath) ahead of the card's
  // own stable instructions string, mirroring local's `agentInstructions +
  // "\n\n---\n\n" + prompt` layering.
  const instructions = agentInstructionsBundle
    ? `${agentInstructionsBundle.trim()}\n\n---\n\n${cardInstructions}`
    : cardInstructions;
  // myrmidon(G4): per-run model/provider/reasoning override from the agent
  // card (api_server.py's _request_agent_overrides); payloadTemplate is
  // spread first so these first-class fields take precedence over it.
  const model = nonEmpty(ctx.config.model);
  const provider = nonEmpty(ctx.config.provider);
  const modelOptions = buildModelOptions(ctx.config);
  return {
    ...payloadTemplate,
    input,
    instructions,
    ...(sessionKey ? { session_id: sessionKey } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(modelOptions ? { model_options: modelOptions } : {}),
  };
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function classifyHttpError(status: number): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "hermes_gateway_auth_failed", family: null };
  if (status === 404) return { code: "hermes_gateway_runs_unsupported", family: null };
  // myrmidon(G4): the idempotency store rejects a reused Idempotency-Key whose
  // request body fingerprint does not match the original (api_server_runs.py
  // _replay_or_conflict); distinct from a plain protocol error so it is
  // diagnosable instead of silently falling into the generic bucket.
  if (status === 409) return { code: "hermes_gateway_idempotency_conflict", family: null };
  if (status === 429) return { code: "hermes_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "hermes_gateway_upstream_error", family: "transient_upstream" };
  return { code: "hermes_gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function fetchJson(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    const fetchErr = new Error(`Hermes gateway request failed: ${fetchFailureMessage(err)}`) as HermesHttpError;
    fetchErr.code = "hermes_gateway_connect_failed";
    throw fetchErr;
  }
  const body = await readResponseJson(response);
  if (!response.ok) {
    const classified = classifyHttpError(response.status);
    const err = new Error(`Hermes gateway HTTP ${response.status}`) as HermesHttpError;
    err.status = response.status;
    err.code = classified.code;
    err.retryNotBefore = response.headers.get("retry-after");
    err.body = body;
    throw err;
  }
  return body;
}

function extractRunId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.run_id) ?? nonEmpty(record?.runId) ?? nonEmpty(record?.id);
}

function eventNameFromData(data: unknown, fallback: string | null): string | null {
  const record = asRecord(data);
  return nonEmpty(record?.event) ?? nonEmpty(record?.type) ?? fallback;
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

export function parseSseFramesForTest(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest: normalized.slice(offset) };
}

function createExecutionState(runId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    runId,
    outputChunks: [],
    lastEventName: null,
    terminal: null,
    resolveTerminal,
    terminalPromise,
    deltaLineBuffer: "",
    toolPreviews: new Map(),
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = terminal;
  state.resolveTerminal(terminal);
}

function extractStatus(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.status)?.toLowerCase() ?? null;
}

function extractOutput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct =
    nonEmpty(record.output) ??
    nonEmpty(record.result) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.message);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractOutput(nested) : null;
}

// myrmidon(G4): --- compact progress logging (gateway-parity-gap.md #25) ---

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function truncateForLog(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Unlike nonEmpty(), this never trims: a delta chunk's own leading/trailing
 * whitespace (in particular a trailing "\n" ending a line) is exactly what
 * flushCompactDeltaLines()'s line splitting depends on. */
function rawDeltaText(record: Record<string, unknown> | null): string {
  const raw = record?.delta ?? record?.text_delta;
  return typeof raw === "string" ? raw : "";
}

function toolNameFromEvent(record: Record<string, unknown> | null): string {
  return nonEmpty(record?.tool) ?? nonEmpty(record?.tool_name) ?? nonEmpty(record?.name) ?? "tool";
}

function toolPreviewFromEvent(record: Record<string, unknown> | null, redactText: TextRedactor): string {
  const preview = nonEmpty(record?.preview) ?? nonEmpty(record?.detail) ?? "";
  return preview ? redactText(preview) : "";
}

function toolDurationSeconds(record: Record<string, unknown> | null): number | null {
  const raw = record?.duration ?? record?.duration_s ?? record?.elapsed_s ?? record?.elapsed;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toolHasError(record: Record<string, unknown> | null): boolean {
  const error = record?.error;
  if (error == null || error === false) return false;
  if (typeof error === "string") return error.trim().length > 0;
  return true;
}

/** Same field fallback chain as gateway/ui/parse-stdout.ts's reasoning extractor. */
function extractReasoningPreview(record: Record<string, unknown> | null): string {
  if (!record) return "";
  const direct =
    nonEmpty(record.reasoning) ??
    nonEmpty(record.reasoning_text) ??
    nonEmpty(record.thinking) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.content);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractReasoningPreview(nested) : "";
}

/** myrmidon(G4): remembers a tool.started preview so the matching tool.completed
 * (which carries none on the wire) can still render a rich [done] line — see
 * ExecutionState.toolPreviews and formatCompactToolCompletedLine. */
function pushToolPreview(state: ExecutionState, name: string, preview: string): void {
  const queue = state.toolPreviews.get(name);
  if (queue) {
    queue.push(preview);
  } else {
    state.toolPreviews.set(name, [preview]);
  }
}

/** myrmidon(G4): FIFO pop — concurrent tool batches (agent/tool_executor.py's
 * execute_tool_calls_concurrent) can have more than one call to the same tool
 * name in flight; the wire protocol gives us no call id to pair start/complete
 * precisely, so call order is the best available approximation. Empty when no
 * matching tool.started was ever observed (e.g. a reconnect mid-call). */
function popToolPreview(state: ExecutionState, name: string): string {
  const queue = state.toolPreviews.get(name);
  return queue?.shift() ?? "";
}

/** `  [tool] <name> <preview>` — real hermes chat prints this per agent/display.py's
 * Spinner._animate(); parseHermesStdoutLine() deliberately discards it (the [done]
 * completion line below carries the structured data), so it exists for human log
 * tails only. */
function formatCompactToolStartedLine(name: string, preview: string): string {
  return `  [tool] ${preview ? `${name} ${preview}` : name}\n`;
}

/** `  [done] ┊ ⚡ <name> <preview>  <duration>s[ [error]]` — the fallback shape
 * agent/display.py's _get_cute_tool_message() writes for a tool with no curated
 * renderer, which is all parseToolCompletionLine() in parseHermesStdoutLine()
 * needs to build a tool_call/tool_result pair.
 *
 * myrmidon(G4): `capturedPreview` must come from that tool call's earlier
 * tool.started line (see popToolPreview), never from `record` — the real
 * gateway's tool.completed payload never carries a preview/detail field
 * (api_server_runs.py's _FIXED_EVENT_FIELDS only keeps `tool`/`duration`/
 * `error` for tool.completed). When no preview was captured, "·" keeps a
 * non-whitespace token between the name and the duration: parseToolCompletionLine()
 * in ui/parse-stdout.ts splits `verb + " " + detail` on the first run of
 * whitespace, and a whitespace-only gap there makes it misparse the tool name
 * itself as the generic "tool" and shove the real name into detail. */
function formatCompactToolCompletedLine(record: Record<string, unknown> | null, name: string, capturedPreview: string): string {
  const paddedName = padRight(name, COMPACT_TOOL_NAME_WIDTH);
  const preview = capturedPreview || "·";
  const duration = toolDurationSeconds(record);
  const durationText = duration !== null ? `${duration.toFixed(1)}s` : "";
  const errorSuffix = toolHasError(record) ? " [error]" : "";
  return `  [done] ${TOOL_OUTPUT_PREFIX} ⚡ ${paddedName} ${preview}  ${durationText}${errorSuffix}\n`;
}

/** One collapsed `  💭 <text>` line; parseHermesStdoutLine()'s isThinkingLine()
 * recognizes any line containing 💭. */
function formatCompactReasoningLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return `  ${THINKING_PREFIX} ${truncateForLog(collapsed, COMPACT_ASSISTANT_PREVIEW_MAX_CHARS)}\n`;
}

async function logCompactEvent(input: {
  ctx: AdapterExecutionContext;
  state: ExecutionState;
  eventName: string | null;
  record: Record<string, unknown> | null;
  redactText: TextRedactor;
}): Promise<void> {
  const { ctx, state, eventName, record, redactText } = input;
  if (eventName === "tool.started") {
    const name = toolNameFromEvent(record);
    const preview = truncateForLog(toolPreviewFromEvent(record, redactText), COMPACT_TOOL_PREVIEW_MAX_CHARS);
    pushToolPreview(state, name, preview);
    await ctx.onLog("stdout", formatCompactToolStartedLine(name, preview));
  } else if (eventName === "tool.completed") {
    const name = toolNameFromEvent(record);
    const preview = popToolPreview(state, name);
    await ctx.onLog("stdout", formatCompactToolCompletedLine(record, name, preview));
  } else if (eventName === "reasoning.available") {
    const reasoning = redactText(extractReasoningPreview(record));
    if (reasoning) await ctx.onLog("stdout", formatCompactReasoningLine(reasoning));
  } else if (eventName === APPROVAL_REQUEST_EVENT) {
    await ctx.onLog("stdout", "[hermes-gateway] approval requested; auto-denying so the run keeps going\n");
  }
  // message.delta is buffered separately (flushCompactDeltaLines); run.* and
  // other control events need no extra line beyond the terminal-state log.
}

/** Flushes complete lines from state.deltaLineBuffer as "  ┊ 💬 <line>" entries
 * (agent/turn_tool_round.py's own `  ┊ 💬 {text}` shape); `final` also flushes a
 * trailing partial line once the run reaches a terminal status. */
async function flushCompactDeltaLines(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  options: { final?: boolean } = {},
): Promise<void> {
  let buffer = state.deltaLineBuffer;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.trim().length > 0) await ctx.onLog("stdout", `  ${TOOL_OUTPUT_PREFIX} 💬 ${line}\n`);
    newlineIndex = buffer.indexOf("\n");
  }
  if (options.final && buffer.trim().length > 0) {
    await ctx.onLog("stdout", `  ${TOOL_OUTPUT_PREFIX} 💬 ${buffer}\n`);
    buffer = "";
  }
  state.deltaLineBuffer = buffer;
}

/** myrmidon(G4): feeds ctx.onRuntimeProgress on every event so the platform's
 * progress-based liveness watchdog (N4) sees this run advancing. hermes_gateway
 * has none of the sandbox-provisioning phases RuntimeStatusPhase was built for
 * (git_sync/config_sync/restore/export/finalize); "adapter_startup" is the
 * closest fit for "the adapter is actively driving a remote run". */
async function reportRuntimeProgress(input: {
  ctx: AdapterExecutionContext;
  eventName: string | null;
  record: Record<string, unknown> | null;
  redactText: TextRedactor;
}): Promise<void> {
  if (!input.ctx.onRuntimeProgress) return;
  const { eventName, record, redactText } = input;
  let message: string | null = null;
  let currentToolName: string | null = null;
  let lastAssistantSnippet: string | null = null;

  if (eventName === "tool.started" || eventName === "tool.completed") {
    currentToolName = toolNameFromEvent(record);
    message = eventName === "tool.started" ? `Using ${currentToolName}` : `Used ${currentToolName}`;
  } else if (eventName === "message.delta") {
    // myrmidon(G4): the untrimmed chunk, not nonEmpty()'s trimmed one — same
    // reasoning as flushCompactDeltaLines below.
    const delta = rawDeltaText(record);
    if (delta.trim().length > 0) {
      lastAssistantSnippet = redactText(delta);
      message = lastAssistantSnippet;
    }
  } else if (eventName === "reasoning.available") {
    message = "Reasoning";
  } else if (eventName === APPROVAL_REQUEST_EVENT) {
    message = "Approval requested (auto-denied)";
  }

  if (!message) return;
  const update: RuntimeStatusUpdate = {
    phase: "adapter_startup",
    message,
    currentToolName,
    lastAssistantSnippet,
    lastEventAt: new Date(),
  };
  await input.ctx.onRuntimeProgress(update);
}

/** myrmidon(G4): approval.request otherwise parks the run in
 * waiting_for_approval until the adapter timeout (gateway-parity-gap.md #23);
 * deny it immediately and log the outcome instead. */
async function denyApproval(input: {
  ctx: AdapterExecutionContext;
  state: ExecutionState;
  record: Record<string, unknown> | null;
  baseUrl: URL;
  headers: Record<string, string>;
  redactText: TextRedactor;
}): Promise<void> {
  const requestId = nonEmpty(input.record?.request_id) ?? nonEmpty(input.record?.requestId);
  const body: Record<string, unknown> = {
    choice: APPROVAL_DENY_CHOICE,
    ...(requestId ? { request_id: requestId } : {}),
  };
  try {
    await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}/approval`), {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(body),
    });
    await input.ctx.onLog(
      "stdout",
      `[hermes-gateway] approval auto-denied${requestId ? ` (request_id=${requestId})` : ""}\n`,
    );
  } catch (err) {
    await input.ctx.onLog(
      "stderr",
      `[hermes-gateway] approval auto-deny request failed: ${redactErrorMessage(err, input.redactText)}\n`,
    );
  }
}

async function handleEvent(input: {
  ctx: AdapterExecutionContext;
  state: ExecutionState;
  frame: SseFrame;
  redactText: TextRedactor;
  debugEvents: boolean;
  baseUrl: URL;
  approvalHeaders: Record<string, string>;
}): Promise<void> {
  const { ctx, state, frame, redactText, debugEvents, baseUrl, approvalHeaders } = input;
  const parsed = parseJsonData(frame.data);
  const record = asRecord(parsed);
  const eventName = eventNameFromData(parsed, frame.event);
  state.lastEventName = eventName;

  if (debugEvents) {
    // myrmidon(G4): raw event JSON is now opt-in (adapterConfig.debugEvents);
    // see logCompactEvent for the default, hermes-chat-shaped log lines.
    await ctx.onLog(
      "stdout",
      `[hermes-gateway:event] run=${state.runId} event=${eventName ?? "message"} data=${stringifyForLog(redactForLog(parsed, [], 0, redactText), 8_000)}\n`,
    );
  } else {
    await logCompactEvent({ ctx, state, eventName, record, redactText });
  }

  await reportRuntimeProgress({ ctx, eventName, record, redactText });

  const delta = nonEmpty(record?.delta) ?? nonEmpty(record?.text_delta);
  if (eventName === "message.delta" && delta) {
    const sanitizedDelta = redactText(delta);
    state.outputChunks.push(sanitizedDelta);
    if (debugEvents) {
      await ctx.onLog("stdout", sanitizedDelta);
    } else {
      // myrmidon(G4): the raw (untrimmed) chunk — nonEmpty()'s trimmed
      // `delta` above would swallow the very newline flushCompactDeltaLines
      // splits lines on, so a chunk ending a line would never flush.
      state.deltaLineBuffer += redactText(rawDeltaText(record));
      await flushCompactDeltaLines(ctx, state);
    }
  }

  if (eventName === APPROVAL_REQUEST_EVENT) {
    await denyApproval({ ctx, state, record, baseUrl, headers: approvalHeaders, redactText });
  }

  const status = extractStatus(parsed) ?? (eventName?.startsWith("run.") ? eventName.slice(4) : null);
  if (status && TERMINAL_STATUSES.has(status)) {
    if (!debugEvents) await flushCompactDeltaLines(ctx, state, { final: true });
    markTerminal(state, {
      runId: state.runId,
      status,
      eventName,
      payload: record,
      output: extractOutput(parsed),
    });
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function pollStatus(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) {
        markTerminal(input.state, {
          runId: input.state.runId,
          status: normalized,
          payload: asRecord(status),
          output: extractOutput(status),
        });
      }
    } catch (err) {
      if (input.signal.aborted) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] status poll failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  approvalHeaders: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText?: TextRedactor;
  debugEvents: boolean;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    try {
      const response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}/events`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog("stderr", `[hermes-gateway] event stream HTTP ${response.status}; falling back to polling\n`);
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog("stderr", "[hermes-gateway] event stream response had no body; falling back to polling\n");
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted && !input.state.terminal) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFramesForTest(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await handleEvent({
                ctx: input.ctx,
                state: input.state,
                frame,
                redactText: input.redactText ?? sanitizeSensitiveText,
                debugEvents: input.debugEvents,
                baseUrl: input.baseUrl,
                approvalHeaders: input.approvalHeaders,
              });
              if (input.state.terminal) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFramesForTest(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await handleEvent({
            ctx: input.ctx,
            state: input.state,
            frame,
            redactText: input.redactText ?? sanitizeSensitiveText,
            debugEvents: input.debugEvents,
            baseUrl: input.baseUrl,
            approvalHeaders: input.approvalHeaders,
          });
          if (input.state.terminal) break;
        }
      }
    } catch (err) {
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] event stream disconnected: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.input, 0);
  const outputTokens = asNumber(source.output_tokens ?? source.outputTokens ?? source.output, 0);
  const cachedInputTokens = asNumber(source.cached_input_tokens ?? source.cachedInputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function parseCostUsd(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record?.cost_usd ?? record?.costUsd ?? asRecord(record?.usage)?.cost_usd ?? asRecord(record?.usage)?.costUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.session_id) ?? nonEmpty(record?.sessionId) ?? nonEmpty(asRecord(record?.data)?.session_id);
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.model) ?? nonEmpty(asRecord(record?.usage)?.model);
}

function extractErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.error) ?? nonEmpty(record?.message) ?? nonEmpty(record?.detail) ?? extractOutput(value);
}

function terminalResultCode(status: string): { exitCode: number; signal: string | null; errorCode: string | null } {
  if (status === "completed") return { exitCode: 0, signal: null, errorCode: null };
  if (FAILURE_STATUSES.has(status)) return { exitCode: 1, signal: null, errorCode: "hermes_gateway_run_failed" };
  if (CANCELLED_STATUSES.has(status)) return { exitCode: 1, signal: "SIGTERM", errorCode: "hermes_gateway_cancelled" };
  return { exitCode: 1, signal: null, errorCode: "hermes_gateway_protocol_error" };
}

export function mapFinalResultForTest(input: {
  terminal: TerminalState;
  outputChunks: string[];
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  redactText?: TextRedactor;
}): AdapterExecutionResult {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  const payload = input.terminal.payload ?? {};
  const output = redactText(
    input.terminal.output ?? extractOutput(payload) ?? input.outputChunks.join("").trim(),
  );
  const sessionId = extractSessionId(payload) ?? input.sessionKey;
  const sessionDisplayId = sessionId ? redactText(sessionId) : null;
  const mapped = terminalResultCode(input.terminal.status);
  const usage = parseUsage(payload);
  const costUsd = parseCostUsd(payload);
  const errorMessage = mapped.errorCode
    ? redactText(extractErrorMessage(payload) ?? `Hermes run ${input.terminal.status}`)
    : null;
  return {
    exitCode: mapped.exitCode,
    signal: mapped.signal,
    timedOut: false,
    provider: "hermes_gateway",
    model: extractModel(payload),
    ...(mapped.errorCode ? { errorCode: mapped.errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
    sessionId: sessionDisplayId,
    sessionParams: {
      hermesRunId: input.terminal.runId,
      ...(sessionId && sessionDisplayId === sessionId ? { hermesSessionId: sessionId } : {}),
      strategy: input.strategy,
    },
    sessionDisplayId,
    resultJson: {
      run_id: input.terminal.runId,
      status: input.terminal.status,
      session_id: sessionDisplayId,
      last_event: input.terminal.eventName ?? null,
      output: output ?? "",
      usage: usage ?? null,
      cost_usd: costUsd,
    },
  };
}

async function stopRun(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  redactText?: TextRedactor;
}): Promise<Record<string, unknown> | null> {
  try {
    const stopped = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/stop`), {
      method: "POST",
      headers: input.headers,
    });
    await input.ctx.onLog("stdout", `[hermes-gateway] stop requested for run ${input.runId}\n`);
    return asRecord(stopped);
  } catch (err) {
    await input.ctx.onLog("stderr", `[hermes-gateway] stop request failed: ${redactErrorMessage(err, input.redactText)}\n`);
    return null;
  }
}

async function fetchFinalStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineMs: number;
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + input.deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}`), {
        method: "GET",
        headers: input.headers,
      });
      const record = asRecord(status);
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) return record;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function redactErrorMessage(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): string {
  if (err instanceof Error) return redactText(err.message);
  return redactText(String(err));
}

function errorResult(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): AdapterExecutionResult {
  const hermesError = err as HermesHttpError;
  const code = hermesError.code ?? "hermes_gateway_protocol_error";
  const classified = hermesError.status ? classifyHttpError(hermesError.status) : null;
  const errorMessage = code === "hermes_gateway_auth_failed"
    ? `${redactErrorMessage(err, redactText)}. Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.`
    : redactErrorMessage(err, redactText);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorFamily: classified?.family ?? (code === "hermes_gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: hermesError.retryNotBefore ?? null,
    errorMessage,
    errorMeta: {
      ...(hermesError.status ? { status: hermesError.status } : {}),
      ...(hermesError.body ? { body: redactForLog(hermesError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiBaseUrlValue = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  if (!apiBaseUrlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_missing",
      errorMessage: "Hermes gateway adapter requires apiBaseUrl.",
    };
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_invalid",
      errorMessage: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    };
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
    };
  }

  const apiKey = nonEmpty(ctx.config.apiKey) ?? nonEmpty(ctx.config.token);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_key_missing",
      errorMessage: "Hermes gateway adapter requires apiKey.",
    };
  }

  const timeoutSec = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutMs = timeoutSec > 0 ? Math.ceil(timeoutSec * 1000) : 0;
  const reconnectMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000));
  const pollIntervalMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000));
  const strategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  // myrmidon(G4): raw debug JSON is opt-in; see handleEvent/logCompactEvent.
  const debugEvents = ctx.config.debugEvents === true;
  // myrmidon(G4): a process_lost retry keeps the *original* run's id as
  // retryOfRunId (heartbeat_runs.retry_of_run_id, surfaced on ctx.context —
  // see server/services/heartbeat.ts's contextSnapshot). Reusing it as the
  // Idempotency-Key lets Hermes recognize the duplicate create request
  // (api_server_run_idempotency.py's reserve/lookup) and reply
  // `replayed:true` with the original run instead of starting a second one.
  // Computed before sessionKey/buildRunBody: both must key off this same
  // stable id (not the per-attempt ctx.runId) so the retry's request body
  // and X-Hermes-Session-Key stay byte-identical to the attempt it replays —
  // Hermes's idempotency_fingerprint hashes body *and* gateway_session_key
  // together (api_server_runs.py), and a "run"-strategy session key or a
  // buildInput() "Run ID:" line built from ctx.runId would otherwise change
  // on every retry and turn a should-be replay into a 409 conflict.
  const retryOfRunId = nonEmpty(ctx.context.retryOfRunId);
  const idempotencyKey = retryOfRunId ?? ctx.runId;
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: idempotencyKey,
    issueId: issueIdFromContext(ctx),
  });
  const extraHeaders = parseHeaders(ctx.config.headers);
  const runHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: idempotencyKey,
    extraHeaders,
    accept: "application/json",
    contentType: "application/json",
  });
  const eventHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: idempotencyKey,
    extraHeaders,
    accept: "text/event-stream",
  });
  const redactText = createTextRedactor([
    apiKey,
    sessionKey,
    runHeaders.Authorization,
    runHeaders["X-Hermes-Session-Key"],
  ]);

  // myrmidon(G4): the instructions bundle Paperclip materializes for managed
  // agents (same instructionsFilePath hermes_local reads — execute.ts
  // ~422-447); supportsInstructionsBundle: true (gateway/index.ts) makes the
  // server populate this key.
  const instructionsFilePath = nonEmpty(ctx.config.instructionsFilePath);
  let agentInstructionsBundle = "";
  if (instructionsFilePath) {
    try {
      agentInstructionsBundle = await fs.readFile(instructionsFilePath, "utf-8");
      await ctx.onLog(
        "stdout",
        `[hermes-gateway] Loaded agent instructions from ${instructionsFilePath} (${agentInstructionsBundle.length} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stdout",
        `[hermes-gateway] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const body = buildRunBody(ctx, sessionKey, agentInstructionsBundle, idempotencyKey);
  const createRunUrl = apiUrl(baseUrl, "/v1/runs");

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "POST /v1/runs",
    commandArgs: [createRunUrl],
    context: {
      runId: ctx.runId,
      timeoutSec,
      eventReconnectMs: reconnectMs,
      sessionKeyStrategy: strategy,
      hasSessionKey: Boolean(sessionKey),
    },
  });
  await ctx.onLog("stdout", `[hermes-gateway] creating run at ${createRunUrl} (timeout=${timeoutSec}s, session=${strategy})\n`);
  await ctx.onLog("stdout", `[hermes-gateway] request headers (redacted): ${stringifyForLog(redactForLog(runHeaders, [], 0, redactText), 3_000)}\n`);

  let runId: string | null = null;
  let replayed = false;
  try {
    // This adapter has no local child process, so crossing into the first
    // remote create request is its dispatch boundary. Report it before the
    // request can block so continuation gates may release their issue lock.
    ctx.onDispatch?.();
    const created = await fetchJson(createRunUrl, {
      method: "POST",
      headers: runHeaders,
      body: JSON.stringify(body),
    });
    runId = extractRunId(created);
    replayed = asRecord(created)?.replayed === true; // myrmidon(G4)
    if (!runId) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "hermes_gateway_protocol_error",
        errorMessage: "Hermes /v1/runs response did not include run_id.",
        errorMeta: { response: redactForLog(created, [], 0, redactText) as Record<string, unknown> },
      };
    }
  } catch (err) {
    return errorResult(err, redactText);
  }

  // myrmidon(G4): a replayed create attaches to the run Hermes already
  // admitted for this Idempotency-Key; consumeEvents/pollStatus below key off
  // the returned run_id either way, so no other branch is needed to "attach".
  await ctx.onLog(
    "stdout",
    replayed
      ? `[hermes-gateway] idempotent replay: attaching to existing run ${runId} instead of starting a new one\n`
      : `[hermes-gateway] run created: ${runId}\n`,
  );

  // myrmidon(G4): register for operator cancellation once there is a run to
  // stop; ctx.signal firing after this resolves races the stop below.
  await ctx.onCancellationReady?.();

  const state = createExecutionState(runId);
  const controller = new AbortController();
  void consumeEvents({
    ctx,
    baseUrl,
    headers: eventHeaders,
    approvalHeaders: runHeaders,
    state,
    signal: controller.signal,
    reconnectMs,
    redactText,
    debugEvents,
  }).catch(() => undefined);
  void pollStatus({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    intervalMs: pollIntervalMs,
    redactText,
  }).catch(() => undefined);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // myrmidon(G4): operator cancellation — see gateway-parity-gap.md #22.
  const cancelPromise = new Promise<"cancelled">((resolve) => {
    if (!ctx.signal) return;
    if (ctx.signal.aborted) {
      resolve("cancelled");
      return;
    }
    ctx.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });

  const outcome = await Promise.race([state.terminalPromise, timeoutPromise, cancelPromise]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  controller.abort();

  if (outcome === "cancelled") {
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: STOP_GRACE_MS });
    return {
      exitCode: 1,
      signal: "SIGTERM",
      timedOut: false,
      errorCode: "hermes_gateway_cancelled",
      errorMessage: "Hermes gateway run was cancelled.",
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: extractStatus(finalStatus) ?? "cancelled",
        last_event: state.lastEventName,
        final_status: redactForLog(finalStatus, [], 0, redactText),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  if (outcome === "timeout") {
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: STOP_GRACE_MS });
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorCode: "hermes_gateway_timeout",
      errorMessage: `Hermes gateway run timed out after ${timeoutSec}s.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: extractStatus(finalStatus) ?? "timeout",
        last_event: state.lastEventName,
        final_status: redactForLog(finalStatus, [], 0, redactText),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  return mapFinalResultForTest({
    terminal: outcome,
    outputChunks: state.outputChunks,
    sessionKey,
    strategy,
    redactText,
  });
}
