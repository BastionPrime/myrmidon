import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTelegramCallbackProvenance,
  isStoredTelegramPrivateActionUnavailableText,
  LEGACY_TELEGRAM_PRIVATE_ACTION_UNAVAILABLE_PAPERCLIP,
  readTelegramCallbackProvenance,
  sendTelegramCallbackNotice,
  TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
} from "./chat-telegram-ephemeral.js";

// B1b: the notice text was rebranded, but a provider-effect row written by an
// earlier build keeps the old text in its stored payload for good. Reading such
// a row must keep working; sending must stay strict about the current text.

const scope = {
  companyId: "company",
  endpointId: "endpoint",
  botUserId: "123",
};
const expected = {
  ...scope,
  threadId: "telegram:-100123:3",
  messageId: "-100123:71",
  userId: "456",
};
function receipt() {
  const value = captureTelegramCallbackProvenance(
    scope,
    {
      update_id: 91,
      callback_query: {
        id: "callback-91",
        data: "pcq:missing",
        from: { id: 456, is_bot: false },
        message: {
          message_id: 71,
          date: 1_780_000_000,
          message_thread_id: 3,
          chat: { id: -100123, type: "supergroup" },
          from: { id: 123, is_bot: true },
        },
      },
    },
    Date.now(),
  )!;
  return readTelegramCallbackProvenance(value.proof, expected)!;
}

describe("Telegram private action notice text across the rebrand (B1b)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the pre-rename literal byte for byte", () => {
    expect(LEGACY_TELEGRAM_PRIVATE_ACTION_UNAVAILABLE_PAPERCLIP).toBe(
      "This Paperclip action is no longer available. Open the linked task or ask an operator to link this account.",
    );
    expect(TELEGRAM_PRIVATE_ACTION_UNAVAILABLE).toBe(
      "This Myrmidon action is no longer available. Open the linked task or ask an operator to link this account.",
    );
  });

  it("accepts the current and the pre-rename text of a stored row and nothing else", () => {
    expect(
      isStoredTelegramPrivateActionUnavailableText(
        TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
      ),
    ).toBe(true);
    expect(
      isStoredTelegramPrivateActionUnavailableText(
        LEGACY_TELEGRAM_PRIVATE_ACTION_UNAVAILABLE_PAPERCLIP,
      ),
    ).toBe(true);
    for (const other of [
      "",
      "This Paperclip action is no longer available.",
      `${TELEGRAM_PRIVATE_ACTION_UNAVAILABLE} `,
      TELEGRAM_PRIVATE_ACTION_UNAVAILABLE.toLowerCase(),
      null,
      undefined,
      42,
      { text: TELEGRAM_PRIVATE_ACTION_UNAVAILABLE },
    ])
      expect(isStoredTelegramPrivateActionUnavailableText(other)).toBe(false);
  });

  it("never sends the pre-rename text", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    await expect(
      sendTelegramCallbackNotice(
        {
          receipt: receipt(),
          text: LEGACY_TELEGRAM_PRIVATE_ACTION_UNAVAILABLE_PAPERCLIP,
          botToken: "123:synthetic",
        },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
