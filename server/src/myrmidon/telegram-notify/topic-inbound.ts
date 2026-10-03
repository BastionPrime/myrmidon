// myrmidon(OPE-3789): topic-inbound gate for the Telegram group-topics
// bridge (part D).
//
// Pure decision helpers, separated from chat-channels.ts so they can be
// unit-tested without the vendor service harness. The vendor integration
// points (admission + task creation) carry their own
// `// myrmidon(OPE-3789): …` markers in chat-channels.ts.

import type { TelegramNotifyInboundSettings } from "./settings.js";

/**
 * Whether a Telegram thread id is a forum-topic thread. Mirrors the vendor's
 * chatSurfaceKind(): `telegram:<chat>:<topic>` is a native thread (topic),
 * plain `telegram:<chat>` is the group root / non-forum group.
 */
export function isTelegramTopicThread(threadId: string): boolean {
  return /^telegram:[^:]+:[^:]+$/.test(threadId);
}

/**
 * Whether an inbound topic message may create or continue task work.
 *
 * - The gate is OFF by default: with `inbound.enabled === false` (the
 *   stored default) nothing is admitted and the vendor path is unchanged.
 * - With `inbound.requireMention === true` (default) an unaddressed
 *   message — one the adapter did not mark as a mention/reply to the bot —
 *   is ignored, exactly as in the vendor's privacy-mode contract for
 *   groups; commands therefore only work when the bot is mentioned, as in
 *   a DM.
 * - The group resource must already be an enabled destination (the
 *   operator granted reach) — enforced by the vendor's admission, the gate
 *   here only adds the two inbound settings on top.
 */
export function topicInboundAdmitted(input: {
  inbound: TelegramNotifyInboundSettings;
  threadId: string;
  addressed: boolean;
}): boolean {
  if (!input.inbound.enabled) return false;
  if (!isTelegramTopicThread(input.threadId)) return false;
  if (input.inbound.requireMention && !input.addressed) return false;
  return true;
}

/**
 * The title of a task created from a topic message: the first words of the
 * message (the vendor's safeTitle() rules: strip bot mentions, first line,
 * capped), with a neutral fallback when the message is empty or
 * mention-only.
 */
export function topicTaskTitle(text: string, botUsername: string | null): string {
  const line = text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/@[\w.-]+(?:\[bot\])?/gi, "")
    .trim()
    .split(/\r?\n/)[0];
  if (!line) {
    return botUsername ? `Telegram topic message for @${botUsername}` : "Telegram topic message";
  }
  return line.slice(0, 160);
}

/**
 * The body of a task created from a topic message: the full text plus a
 * reference to the provider thread, so the task body always carries the
 * thread link even when the title truncated the content.
 */
export function topicTaskBody(input: {
  text: string;
  threadUrl: string | null;
  chatLabel: string | null;
}): string {
  const lines: string[] = [];
  const text = input.text.trim();
  lines.push(text.length > 0 ? text : "(empty message)");
  lines.push("");
  const origin = input.chatLabel ? ` (from ${input.chatLabel})` : "";
  if (input.threadUrl) {
    lines.push(`Origin: Telegram topic${origin} — ${input.threadUrl}`);
  } else {
    lines.push(`Origin: Telegram topic${origin}`);
  }
  return lines.join("\n");
}
