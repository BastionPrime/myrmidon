import { describe, expect, it } from "vitest";
import {
  createOmissionTracker,
  effectiveTelegramAttachmentLimitBytes,
  MAX_TRACKED_OMISSIONS,
  telegramAttachmentOmissionNotice,
} from "../myrmidon/chat-attachment-omission.js";

const MB = 1024 * 1024;

describe("Telegram attachment omission notice", () => {
  it("returns null when nothing was omitted", () => {
    const tracker = createOmissionTracker();
    expect(telegramAttachmentOmissionNotice(tracker, 10 * MB)).toBeNull();
  });

  it("names a single dropped file with its reason and the limit", () => {
    const tracker = createOmissionTracker();
    tracker.omit("declared_too_large", 1, ["deck.pptx"]);
    expect(telegramAttachmentOmissionNotice(tracker, 10 * MB)).toBe(
      'Could not import the attached Telegram file: "deck.pptx" — declared too large. Please resend it as a supported file under 10 MB.',
    );
  });

  it("names up to three files and summarizes the rest", () => {
    const tracker = createOmissionTracker();
    tracker.omit("unsupported_type", 1, ["a.bin"]);
    tracker.omit("empty_download", 1, ["b.txt"]);
    tracker.omit("downloaded_too_large", 1, ["c.mp4"]);
    tracker.omit("processing_failed", 2, ["d.pdf", "e.pdf"]);
    expect(telegramAttachmentOmissionNotice(tracker, 25 * MB)).toBe(
      'Could not import 5 attached Telegram files: "a.bin" — unsupported type; "b.txt" — empty download; "c.mp4" — downloaded too large; and 2 more. Please resend them as supported files under 25 MB.',
    );
  });

  it("never renders reason codes outside the closed list", () => {
    const tracker = createOmissionTracker();
    tracker.omit("provider_secret_diagnostic", 1, ["x.txt"]);
    tracker.omit("storage_unavailable", 1);
    const notice = telegramAttachmentOmissionNotice(tracker, MB);
    expect(notice).toContain('"x.txt" — could not be imported');
    expect(notice).toContain("storage unavailable");
    expect(notice).not.toContain("provider_secret_diagnostic");
    expect(notice).not.toContain("provider secret diagnostic");
  });

  it("keeps counts authoritative but bounds tracked details", () => {
    const tracker = createOmissionTracker();
    tracker.omit("attachment_limit", MAX_TRACKED_OMISSIONS + 10);
    expect(tracker.omissionReasons).toEqual({
      attachment_limit: MAX_TRACKED_OMISSIONS + 10,
    });
    expect(tracker.omitted).toHaveLength(MAX_TRACKED_OMISSIONS);
    expect(telegramAttachmentOmissionNotice(tracker, MB)).toContain(
      `and ${MAX_TRACKED_OMISSIONS + 10 - 3} more`,
    );
  });
});

describe("effective Telegram attachment limit", () => {
  it("is capped by the cloud Bot API without a self-hosted API", () => {
    expect(effectiveTelegramAttachmentLimitBytes({}, 500 * MB)).toBe(20 * MB);
  });

  it("is capped by the adapter default with a self-hosted API", () => {
    expect(
      effectiveTelegramAttachmentLimitBytes(
        { TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081" },
        500 * MB,
      ),
    ).toBe(25 * MB);
  });

  it("follows the configured adapter ceiling and the board limit", () => {
    const env = {
      TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081",
      MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES: String(2048 * MB),
    };
    expect(effectiveTelegramAttachmentLimitBytes(env, 500 * MB)).toBe(500 * MB);
    expect(effectiveTelegramAttachmentLimitBytes(env, 4096 * MB)).toBe(
      2048 * MB,
    );
  });

  it("never exceeds the board limit", () => {
    expect(effectiveTelegramAttachmentLimitBytes({}, 10 * MB)).toBe(10 * MB);
  });
});
