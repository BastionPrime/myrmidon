// server/src/myrmidon/cto-chat/index.ts
//
// myrmidon(1.6-CTO-CHAT-B): the entry point of the CTO chat planner.
//
// The feature in one line: the owner writes what he wants, the board answers
// with a proposed epic and its child tasks, and approving that proposal is what
// creates the tasks. This module is the half that runs on the server — the
// planning step, the approval card and the Telegram entry point. The portal chat
// screen is the other half (myrmidon 1.6-CTO-CHAT-A); the two meet only at the
// shared proposal contract in `@paperclipai/shared` and at the board's own
// interaction API, so neither half calls into the other.
//
// Deliberately absent:
//   - no new card type. The board's `suggest_tasks` interaction already means
//     "here are task drafts, accept to create them", and its acceptance path
//     (issue-thread-interactions) is what creates issues;
//   - no second chat transport and no second publication path for Telegram. The
//     bridge resolves the turn and reports the card back; the card itself is
//     created on the standing conversation task, where the owner reads it;
//   - no storage of proposals. A proposal is an answer to one message, and the
//     only durable thing it produces is the card.

export {
  CtoChatRuntimeError,
  createCtoChatRuntime,
  createCtoChatRuntimeForDb,
  type CtoChatRuntime,
  type CtoChatRuntimeOptions,
} from "./runtime.js";
export {
  CtoChatPlanError,
  ctoChatCompletionUrl,
  extractPlanJson,
  generateCtoChatPlan,
  normalizePlannedAnswer,
  type CtoChatPlanDeps,
  type CtoChatPlanErrorCode,
  type CtoChatPlanResult,
} from "./plan-generator.js";
export {
  CtoChatApprovalError,
  createCtoChatPlanApproval,
  ctoChatApprovalIdempotencyKey,
  type CtoChatApprovalCard,
  type CtoChatApprovalDeps,
} from "./plan-approval.js";
export {
  CTO_CHAT_TELEGRAM_SOURCE,
  cardSummary,
  describeTelegramOutcome,
  planFromTelegramTurn,
  type CtoChatTelegramEntryDeps,
  type CtoChatTelegramOutcome,
  type CtoChatTelegramTurn,
} from "./telegram-entry.js";
export {
  CTO_CHAT_ABSOLUTE_MAX_TASKS,
  CTO_CHAT_BASE_URL_ENV,
  CTO_CHAT_KEY_SECRET_ENV,
  CTO_CHAT_MAX_TASKS_ENV,
  CTO_CHAT_MODEL_ENV,
  CTO_CHAT_TIMEOUT_SEC_ENV,
  DEFAULT_CTO_CHAT_MODEL,
  DEFAULT_CTO_CHAT_TIMEOUT_SEC,
  ctoChatSettingsProblem,
  readCtoChatSettings,
  type CtoChatSettings,
} from "./settings.js";
export { myrmidonCtoChatRoutes } from "./routes.js";