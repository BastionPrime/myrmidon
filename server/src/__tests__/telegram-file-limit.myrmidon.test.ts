import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "@chat-adapter/telegram";

// myrmidon(P8): the vendored adapter patch clamps Telegram downloads to 25 MB.
// A self-hosted Bot API serves files up to 2 GB, so the ceiling is raised only
// through MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES.

const VENDOR_CEILING = 25 * 1024 * 1024;
const TWO_GB = 2 * 1024 * 1024 * 1024;

function downloadCeiling(maxDownloadBytes?: number): number {
  const adapter = createTelegramAdapter({
    botToken: "123456:test-token",
    ...(maxDownloadBytes === undefined ? {} : { maxDownloadBytes }),
  });
  return (adapter as unknown as { maxDownloadBytes: number }).maxDownloadBytes;
}

describe("Telegram download ceiling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the vendor 25 MB clamp without the setting", () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES", "");
    expect(downloadCeiling(TWO_GB)).toBe(VENDOR_CEILING);
    expect(downloadCeiling()).toBe(VENDOR_CEILING);
    expect(downloadCeiling(10 * 1024 * 1024)).toBe(10 * 1024 * 1024);
  });

  it("accepts downloads up to 2 GB when the setting allows it", () => {
    vi.stubEnv("MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES", String(TWO_GB));
    expect(downloadCeiling(TWO_GB)).toBe(TWO_GB);
    expect(downloadCeiling(TWO_GB + 1)).toBe(TWO_GB);
    expect(downloadCeiling(500 * 1024 * 1024)).toBe(500 * 1024 * 1024);
  });

  it.each(["0", "-1", "not-a-number"])(
    "falls back to the vendor clamp for an invalid setting %j",
    (value) => {
      vi.stubEnv("MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES", value);
      expect(downloadCeiling(TWO_GB)).toBe(VENDOR_CEILING);
    },
  );
});
