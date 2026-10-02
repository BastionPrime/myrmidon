import { describe, expect, it, vi, afterEach } from "vitest";
import {
  telegramDmStatusEnabled,
  telegramSplitMaxParts,
} from "./telegram-dm-status-settings.js";

// myrmidon(U1): settings contract for the Telegram DM status surface
// (release 1.4, item 3). Defaults keep the vendor path byte for byte.

describe("telegram DM status settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("telegramDmStatusEnabled", () => {
    it("is off by default and for unset or blank values", () => {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_STATUS", "");
      expect(telegramDmStatusEnabled()).toBe(false);
      vi.unstubAllEnvs();
      expect(telegramDmStatusEnabled()).toBe(false);
      expect(telegramDmStatusEnabled({})).toBe(false);
    });

    it.each(["1", "true", "YES", "on", "On"])(
      "accepts %j as enabled",
      (value) => {
        vi.stubEnv("MYRMIDON_TELEGRAM_DM_STATUS", value);
        expect(telegramDmStatusEnabled()).toBe(true);
      },
    );

    it.each(["0", "false", "no", "off", "garbage", "enable"])(
      "treats %j as disabled",
      (value) => {
        vi.stubEnv("MYRMIDON_TELEGRAM_DM_STATUS", value);
        expect(telegramDmStatusEnabled()).toBe(false);
      },
    );

    it("trims surrounding whitespace", () => {
      vi.stubEnv("MYRMIDON_TELEGRAM_DM_STATUS", " true ");
      expect(telegramDmStatusEnabled()).toBe(true);
    });
  });

  describe("telegramSplitMaxParts", () => {
    it("defaults to 0 (vendor single-attachment behavior)", () => {
      vi.stubEnv("MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS", "");
      expect(telegramSplitMaxParts()).toBe(0);
      vi.unstubAllEnvs();
      expect(telegramSplitMaxParts()).toBe(0);
      expect(telegramSplitMaxParts({})).toBe(0);
    });

    it("reads a positive cap", () => {
      vi.stubEnv("MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS", "8");
      expect(telegramSplitMaxParts()).toBe(8);
    });

    it.each(["-1", "not-a-number", "1.5", "999999999999999999999"])(
      "falls back to 0 for %j",
      (value) => {
        vi.stubEnv("MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS", value);
        expect(telegramSplitMaxParts()).toBe(0);
      },
    );
  });
});
