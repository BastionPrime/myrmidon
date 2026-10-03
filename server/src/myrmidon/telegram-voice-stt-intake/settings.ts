// server/src/myrmidon/telegram-voice-stt-intake/settings.ts
//
// myrmidon(1.6.1 VOICE-STT B): switch and contract seam for transcribing
// Telegram voice/audio messages at inbound intake.
//
// The vendor intake path is unchanged unless this feature is enabled. Until the
// shared STT core (module `server/src/myrmidon/stt/`) is merged, the
// transcription hook is optional: the wiring in chat-channels passes one when
// the module is available, and the setting is read per delivery, so the same
// seam works with a mock in tests and with the real core after it lands.
//
// The env shape mirrors the other myrmidon switches (for example
// telegram-dm-status-settings.ts): off by default, truthy values enable,
// anything else keeps the vendor behavior byte for byte.

export const TELEGRAM_VOICE_STT_ENV = "MYRMIDON_TELEGRAM_VOICE_STT";

/**
 * Whether inbound Telegram voice/audio turns get their transcript written into
 * the task comment next to the attachment. Off by default: with the setting
 * unset the vendor intake path makes no transcription call and produces the
 * same comment body as before.
 */
export function telegramVoiceSttEnabled(
  env?: Record<string, string | undefined>,
): boolean {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ??
    {};
  const raw = source[TELEGRAM_VOICE_STT_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
