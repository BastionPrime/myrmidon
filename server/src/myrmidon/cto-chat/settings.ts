// server/src/myrmidon/cto-chat/settings.ts
//
// myrmidon(1.6-CTO-CHAT-B): where the chat planner gets its model and its
// limits.
//
// The planner calls an OpenAI-compatible chat endpoint from the SERVER (not
// from a bot container and not from a CLI behind the harness), so the address,
// the model and the *name* of the company secret holding the key are instance
// settings — never the key itself. The key is read from the company's secrets
// at call time, exactly as the OCR path does it (myrmidon EXT-CASE-OCR), so an
// operator can rotate it without touching the server configuration and one
// company's contour never leaks into another company's call.
//
// Unset (the default) means the planner is off: a chat screen asking for a plan
// gets a stable "not configured" answer instead of a request to an address
// nobody set. A value that is present but unusable (a non-integer limit, a
// nonsense timeout) falls back to the default rather than disabling the path —
// `npm config` style operator typos must not close a working feature.

/** Address of the OpenAI-compatible gateway the planner talks to. */
export const CTO_CHAT_BASE_URL_ENV = "MYRMIDON_CTO_CHAT_BASE_URL";
/** Name of the company secret holding the API key, not the key. */
export const CTO_CHAT_KEY_SECRET_ENV = "MYRMIDON_CTO_CHAT_KEY_SECRET";
/** Model to plan with; the free DashScope model unless an operator says otherwise. */
export const CTO_CHAT_MODEL_ENV = "MYRMIDON_CTO_CHAT_MODEL";
export const CTO_CHAT_TIMEOUT_SEC_ENV = "MYRMIDON_CTO_CHAT_TIMEOUT_SEC";
/** Cap on child tasks in one proposal; the wire contract caps it too. */
export const CTO_CHAT_MAX_TASKS_ENV = "MYRMIDON_CTO_CHAT_MAX_TASKS";

/** The free model the release note names for new board-side model calls. */
export const DEFAULT_CTO_CHAT_MODEL = "dashscope-qwen-flash";
export const DEFAULT_CTO_CHAT_TIMEOUT_SEC = 90;
export const DEFAULT_CTO_CHAT_MAX_TASKS = 8;

const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 600;
/** Hard ceiling on the setting, so one proposal can never be unbounded work. */
export const CTO_CHAT_ABSOLUTE_MAX_TASKS = 20;

export interface CtoChatSettings {
  /** Off unless an address and a key secret are both configured. */
  enabled: boolean;
  baseUrl: string | null;
  /** Company secret name holding the API key. */
  keySecret: string | null;
  model: string;
  timeoutMs: number;
  maxTasks: number;
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0 || value > max) return fallback;
  return value;
}

/**
 * The settings an instance plans with. A missing address or key secret is the
 * documented way to leave the planner closed; everything else degrades to its
 * default instead of disabling the path.
 */
export function readCtoChatSettings(env: NodeJS.ProcessEnv = process.env): CtoChatSettings {
  const baseUrl = env[CTO_CHAT_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[CTO_CHAT_KEY_SECRET_ENV]?.trim() || null;
  const timeoutSec = readPositiveInt(
    env[CTO_CHAT_TIMEOUT_SEC_ENV],
    DEFAULT_CTO_CHAT_TIMEOUT_SEC,
    MAX_TIMEOUT_SEC,
  );
  const maxTasks = Math.min(
    readPositiveInt(env[CTO_CHAT_MAX_TASKS_ENV], DEFAULT_CTO_CHAT_MAX_TASKS, CTO_CHAT_ABSOLUTE_MAX_TASKS),
    CTO_CHAT_ABSOLUTE_MAX_TASKS,
  );
  return {
    enabled: Boolean(baseUrl && keySecret),
    baseUrl,
    keySecret,
    model: env[CTO_CHAT_MODEL_ENV]?.trim() || DEFAULT_CTO_CHAT_MODEL,
    timeoutMs: Math.max(timeoutSec, MIN_TIMEOUT_SEC) * 1000,
    maxTasks,
  };
}

/**
 * Why the planner cannot serve a call, or null when it can. The message names
 * the settings, never a value, so it is safe to return over the API and to
 * write into the journal.
 */
export function ctoChatSettingsProblem(settings: CtoChatSettings): string | null {
  if (settings.baseUrl && settings.keySecret) return null;
  const missing = [
    settings.baseUrl ? null : CTO_CHAT_BASE_URL_ENV,
    settings.keySecret ? null : CTO_CHAT_KEY_SECRET_ENV,
  ].filter((name): name is string => name !== null);
  return `The board chat planner is not configured on this instance: set ${missing.join(" and ")}`;
}