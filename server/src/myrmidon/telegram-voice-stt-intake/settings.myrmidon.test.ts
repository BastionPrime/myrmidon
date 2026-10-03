// server/src/myrmidon/telegram-voice-stt-intake/settings.myrmidon.test.ts
//
// myrmidon(1.6.1 VOICE-STT B): settings contract for inbound voice
// transcription. Defaults keep the vendor intake path byte for byte.

import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramVoiceSttEnabled, TELEGRAM_VOICE_STT_ENV } from "./settings.js";

describe("telegram voice STT settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off by default and for unset or blank values", () => {
    vi.stubEnv(TELEGRAM_VOICE_STT_ENV, "");
    expect(telegramVoiceSttEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(telegramVoiceSttEnabled()).toBe(false);
    expect(telegramVoiceSttEnabled({})).toBe(false);
    expect(TELEGRAM_VOICE_STT_ENV).toBe("MYRMIDON_TELEGRAM_VOICE_STT");
  });

  it.each(["1", "true", "YES", "on", "On"])(`accepts %j as enabled`, (value) => {
    vi.stubEnv(TELEGRAM_VOICE_STT_ENV, value);
    expect(telegramVoiceSttEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", "garbage", "enable"])(
    `treats %j as disabled`,
    (value) => {
      vi.stubEnv(TELEGRAM_VOICE_STT_ENV, value);
      expect(telegramVoiceSttEnabled()).toBe(false);
    },
  );

  it("trims surrounding whitespace", () => {
    vi.stubEnv(TELEGRAM_VOICE_STT_ENV, " true ");
    expect(telegramVoiceSttEnabled()).toBe(true);
  });
});