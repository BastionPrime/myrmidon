// server/src/myrmidon/telegram-notify/index.ts
//
// myrmidon(OPE-3789-B): entry point of the jobs half of the Telegram notify
// track. The settings routes belong to part A; this module exports only what
// server/src/index.ts and the tests need.

export {
  startTelegramNotifyJobs,
  runDigestForCompany,
  runEscalationsForCompany,
  buildDigestSections,
  renderDigestBody,
  parseDigestTime,
  digestAlreadySent,
  resolveTargetConversation,
  readTelegramNotifyTickMs,
  TELEGRAM_NOTIFY_TICK_SEC_ENV,
  telegramNotifyJobPorts,
  type TelegramNotifyJobPorts,
  type TelegramNotifyJobs,
  type AttentionSnapshot,
  type AttentionSnapshotItem,
  type DigestSection,
  type DigestSectionView,
} from "./jobs.js";
export {
  readTelegramNotifyDocument,
  mutateTelegramNotifyDocument,
  preserveTelegramNotifyGeneralKey,
  emptyTelegramNotifyDocument,
  TELEGRAM_NOTIFY_GENERAL_KEY,
  type TelegramNotifyDocument,
} from "./store.js";
export {
  defaultTelegramNotifySettings,
  type TelegramNotifySettings,
  type TelegramNotifyDigestSettings,
  type TelegramNotifyEscalationsSettings,
} from "./settings.js";
