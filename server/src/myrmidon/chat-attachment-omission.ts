import { formatAttachmentSize, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

// myrmidon(P7): tell a Telegram sender which attachments were dropped at import
// instead of acknowledging the turn as if every file arrived.

/**
 * Omission reasons that may be shown to the sender. They are the closed
 * current-input vocabulary the native prompts already expose; any other code is
 * a provider-internal diagnostic and is rendered generically.
 */
export const SENDER_VISIBLE_ATTACHMENT_OMISSION_REASONS: ReadonlySet<string> =
  new Set([
    "attachment_limit",
    "storage_unavailable",
    "declared_too_large",
    "download_unavailable",
    "unsupported_type",
    "empty_download",
    "downloaded_too_large",
    "processing_failed",
  ]);

/** Upper bound on per-file omission details carried out of ingestion. */
export const MAX_TRACKED_OMISSIONS = 50;

/** How many dropped files the notice names before summarizing the rest. */
export const SENDER_NOTICE_ATTACHMENT_LIMIT = 3;

export interface OmittedAttachment {
  name: string | null;
  reason: string;
}

/**
 * Collects per-file omission details next to the authoritative reason counts.
 * `names` carries the provider file name for each counted file when known.
 */
export function createOmissionTracker() {
  const omissionReasons: Record<string, number> = {};
  const omitted: OmittedAttachment[] = [];
  const omit = (
    reason: string,
    count = 1,
    names: ReadonlyArray<string | null> = [],
  ) => {
    omissionReasons[reason] = (omissionReasons[reason] ?? 0) + count;
    for (let index = 0; index < count; index += 1) {
      if (omitted.length >= MAX_TRACKED_OMISSIONS) break;
      omitted.push({ name: names[index] ?? null, reason });
    }
  };
  return { omissionReasons, omitted, omit };
}

// The vendor adapter patch clamps downloads to 25 MB unless raised (P8).
const TELEGRAM_ADAPTER_DEFAULT_LIMIT_BYTES = 25 * 1024 * 1024;
// The cloud Bot API refuses getFile for anything larger than 20 MB.
const TELEGRAM_CLOUD_API_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * The largest Telegram file that can actually reach the board: the smallest of
 * the board attachment limit, the adapter download ceiling, and — without a
 * self-hosted Bot API — the cloud API limit.
 */
export function effectiveTelegramAttachmentLimitBytes(
  env: NodeJS.ProcessEnv = process.env,
  boardLimitBytes: number = MAX_ATTACHMENT_BYTES,
): number {
  const configured = Math.max(
    0,
    Math.trunc(Number(env.MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES)),
  );
  const adapterLimit = configured || TELEGRAM_ADAPTER_DEFAULT_LIMIT_BYTES;
  const apiLimit = env.TELEGRAM_API_BASE_URL?.trim()
    ? Number.POSITIVE_INFINITY
    : TELEGRAM_CLOUD_API_LIMIT_BYTES;
  return Math.min(boardLimitBytes, adapterLimit, apiLimit);
}

/**
 * Sender-facing notice for attachments dropped from a delivered Telegram turn,
 * or null when nothing was omitted.
 */
export function telegramAttachmentOmissionNotice(
  result: {
    omissionReasons: Record<string, number>;
    omitted: ReadonlyArray<OmittedAttachment>;
  },
  limitBytes: number = effectiveTelegramAttachmentLimitBytes(),
): string | null {
  const total = Object.values(result.omissionReasons).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (!total) return null;
  const described = result.omitted
    .slice(0, SENDER_NOTICE_ATTACHMENT_LIMIT)
    .map((entry) => {
      const reason = SENDER_VISIBLE_ATTACHMENT_OMISSION_REASONS.has(entry.reason)
        ? entry.reason.replaceAll("_", " ")
        : "could not be imported";
      return entry.name ? `"${entry.name}" — ${reason}` : reason;
    });
  const remaining = total - described.length;
  const detail = described.length
    ? remaining > 0
      ? `${described.join("; ")}; and ${remaining} more`
      : described.join("; ")
    : `${total} files`;
  const limit = formatAttachmentSize(limitBytes);
  return total === 1
    ? `Could not import the attached Telegram file: ${detail}. Please resend it as a supported file under ${limit}.`
    : `Could not import ${total} attached Telegram files: ${detail}. Please resend them as supported files under ${limit}.`;
}
