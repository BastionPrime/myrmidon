// server/src/myrmidon/cto-chat/plan-generator.ts
//
// myrmidon(1.6-CTO-CHAT-B): the owner's free text becomes a proposed epic with
// child tasks, and nothing else happens here.
//
// The order is the whole design, and it mirrors the OCR path (myrmidon
// EXT-CASE-OCR) that already calls the same kind of gateway from the server:
//
//   1. the message is checked against the limits BEFORE the model is called, so
//      an empty or oversized request costs nothing;
//   2. the model answers once — a failure is never retried here, because a retry
//      would multiply a slow, paid call;
//   3. the answer is validated against the shared contract and mapped onto the
//      vendor's existing `suggest_tasks` card payload. A model that answers with
//      prose, with JSON that does not fit the contract, or with a plan the card
//      would reject is a stable error, not a half-built card.
//
// The planner CREATES NOTHING. No issue, no interaction, no document: the caller
// decides what to do with a proposal, and the card's own acceptance path is what
// creates tasks. That keeps this module testable with a fake `fetch` alone.
//
// Model output never reaches a log line or an error message: the error carries a
// code and the HTTP status, not the response body — a failing gateway can echo
// the request, and the request is the owner's text.

import {
  assertCtoChatPlanAcceptable,
  ctoChatPlanSchema,
  toSuggestTasksPayload,
  type CtoChatPlan,
  type CtoChatSuggestTasksPayload,
} from "@paperclipai/shared";

import type { CtoChatSettings } from "./settings.js";

/** Stable failure codes. A caller switches on these, never on a message. */
export type CtoChatPlanErrorCode =
  | "planner_disabled"
  | "empty_message"
  | "message_too_long"
  | "backend_unreachable"
  | "backend_failed"
  | "model_output_invalid";

export class CtoChatPlanError extends Error {
  readonly code: CtoChatPlanErrorCode;
  /** HTTP status of the gateway, when the failure was one. Never the body. */
  readonly status: number | null;

  constructor(code: CtoChatPlanErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "CtoChatPlanError";
    this.code = code;
    this.status = status;
  }
}

export interface CtoChatPlanDeps {
  fetch: typeof fetch;
  settings: CtoChatSettings;
  /** Read from the company's secrets for this call; never stored on the deps. */
  apiKey: string;
}

/** One planned proposal, with the card payload ready to hand to the board. */
export interface CtoChatPlanResult {
  plan: CtoChatPlan;
  /** The board's existing `suggest_tasks` payload for this proposal. */
  payload: CtoChatSuggestTasksPayload;
}

/** The message cap; the shared request schema caps it too. */
export const CTO_CHAT_MAX_MESSAGE_CHARS = 20_000;

const SYSTEM_PROMPT = [
  "You plan work for a software team. You are given one free-text request and you",
  "answer with a single JSON object describing one epic and its child tasks.",
  "",
  "The JSON object is exactly:",
  '{ "epic": { "title": string, "description": string, "acceptanceCriteria": string[] },',
  '  "tasks": [ { "clientKey": string, "title": string, "description": string,',
  '               "acceptanceCriteria": string[], "priority": "critical"|"high"|"medium"|"low" } ] }',
  "",
  "Rules:",
  "- Answer with the JSON object only. No prose, no code fences, no comments.",
  "- Titles are short and imperative. Descriptions say what the result is.",
  "- acceptanceCriteria are concrete, checkable statements, one per item.",
  "- Each child task must be work one engineer can finish on its own.",
  "- clientKey is a short lowercase identifier unique within the answer.",
  "- Do not invent requirements the request does not imply. If the request is",
  "  vague, plan the smallest thing that satisfies it.",
].join("\n");

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** `/v1/chat/completions` unless the configured address already ends with `/v1`. */
export function ctoChatCompletionUrl(baseUrl: string): string {
  return /\/v1$/.test(baseUrl.replace(/\/+$/, ""))
    ? joinUrl(baseUrl, "/chat/completions")
    : joinUrl(baseUrl, "/v1/chat/completions");
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

/**
 * Take the model's answer apart into a JSON object. A chat model asked for JSON
 * still sometimes wraps it in a code fence or puts a sentence in front; both are
 * recovered here rather than treated as a broken plan. Anything else is
 * `model_output_invalid` — this function never guesses at a half-parsed plan.
 */
export function extractPlanJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CtoChatPlanError("model_output_invalid", "The model answered with nothing");
  }
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "")
    : trimmed;
  const first = withoutFence.indexOf("{");
  const last = withoutFence.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new CtoChatPlanError("model_output_invalid", "The model answer contains no JSON object");
  }
  try {
    return JSON.parse(withoutFence.slice(first, last + 1)) as unknown;
  } catch {
    throw new CtoChatPlanError("model_output_invalid", "The model answer is not valid JSON");
  }
}

/** Loose shape of what the model is asked to return, before contract validation. */
interface RawPlannedAnswer {
  epic?: { title?: unknown; description?: unknown; acceptanceCriteria?: unknown };
  tasks?: Array<{
    clientKey?: unknown;
    title?: unknown;
    description?: unknown;
    acceptanceCriteria?: unknown;
    priority?: unknown;
  }>;
}

function readCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const EPIC_CLIENT_KEY = "epic";

/**
 * Normalize the model's answer into the shared plan contract. The epic key is
 * fixed rather than taken from the model: the card needs a parent key for every
 * child, and a model that omits or renames its own epic key would produce a card
 * whose children have no parent.
 */
export function normalizePlannedAnswer(raw: unknown, planId: string, maxTasks: number): CtoChatPlan {
  const answer = (raw ?? {}) as RawPlannedAnswer;
  const epic = answer.epic;
  const epicTitle = readText(epic?.title);
  if (!epicTitle) {
    throw new CtoChatPlanError("model_output_invalid", "The model answer names no epic");
  }
  const rawTasks = Array.isArray(answer.tasks) ? answer.tasks : [];
  const seen = new Set<string>([EPIC_CLIENT_KEY]);
  const tasks: Array<{
    clientKey: string;
    title: string;
    description: string | null;
    acceptanceCriteria: string[];
    priority: string | null;
  }> = [];
  for (const candidate of rawTasks) {
    const title = readText(candidate?.title);
    if (!title) continue;
    const proposedKey = readText(candidate?.clientKey);
    const slug = (proposedKey ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const baseKey = slug.length > 0 ? slug : `task-${tasks.length + 1}`;
    let clientKey = baseKey;
    let suffix = 2;
    while (seen.has(clientKey)) {
      clientKey = `${baseKey}-${suffix}`;
      suffix += 1;
    }
    seen.add(clientKey);
    const priority = readText(candidate?.priority);
    tasks.push({
      clientKey,
      title,
      description: readText(candidate?.description),
      acceptanceCriteria: readCriteria(candidate?.acceptanceCriteria),
      priority: priority && ["critical", "high", "medium", "low"].includes(priority) ? priority : null,
    });
    if (tasks.length >= maxTasks) break;
  }
  if (tasks.length === 0) {
    throw new CtoChatPlanError("model_output_invalid", "The model answer proposes no child tasks");
  }
  try {
    return ctoChatPlanSchema.parse({
      planId,
      epicClientKey: EPIC_CLIENT_KEY,
      epic: {
        title: epicTitle,
        description: readText(epic?.description),
        acceptanceCriteria: readCriteria(epic?.acceptanceCriteria),
      },
      tasks,
    }) as CtoChatPlan;
  } catch {
    throw new CtoChatPlanError("model_output_invalid", "The model answer does not fit the plan contract");
  }
}

/**
 * Ask the model for one proposal. `planId` is an opaque handle minted by the
 * caller; nothing about a proposal is persisted, so it exists only to correlate
 * the answer with the request that produced it.
 */
export async function generateCtoChatPlan(
  input: { text: string; planId: string },
  deps: CtoChatPlanDeps,
): Promise<CtoChatPlanResult> {
  const message = input.text.trim();
  if (deps.settings.baseUrl === null || deps.settings.keySecret === null) {
    throw new CtoChatPlanError("planner_disabled", "The board chat planner is not configured");
  }
  if (message.length === 0) {
    throw new CtoChatPlanError("empty_message", "The request is empty");
  }
  if (message.length > CTO_CHAT_MAX_MESSAGE_CHARS) {
    throw new CtoChatPlanError(
      "message_too_long",
      `The request is ${message.length} characters; the limit is ${CTO_CHAT_MAX_MESSAGE_CHARS}`,
    );
  }

  const body = {
    model: deps.settings.model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
  };
  let response: Response;
  try {
    response = await deps.fetch(ctoChatCompletionUrl(deps.settings.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.settings.timeoutMs),
    });
  } catch (error) {
    throw new CtoChatPlanError(
      "backend_unreachable",
      `The planning model is unreachable: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }
  if (!response.ok) {
    throw new CtoChatPlanError("backend_failed", `The planning model answered ${response.status}`, response.status);
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new CtoChatPlanError("backend_failed", "The planning model answered with a body that is not JSON");
  }
  const text = readChatText(
    (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content,
  );
  const plan = normalizePlannedAnswer(extractPlanJson(text), input.planId, deps.settings.maxTasks);
  const accepted = assertCtoChatPlanAcceptable(plan);
  return { plan: accepted, payload: toSuggestTasksPayload(accepted) };
}