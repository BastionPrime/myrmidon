// server/src/myrmidon/telegram-voice-stt-intake/intake.myrmidon.test.ts
//
// myrmidon(1.6.1 VOICE-STT B): unit coverage of the intake seam with a mock
// transcriber (the shared STT core is a separate module, part A1). Guards:
//   - setting off → zero transcriber calls and zero byte downloads;
//   - a null hook (core not wired) → zero byte downloads;
//   - any failure → a stable redacted skip code, never a throw;
//   - success → the composed comment body, with the identified MIME.

import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import { TELEGRAM_VOICE_OGG } from "../../__tests__/fixtures/telegram-voice.js";
import {
  classifyVoiceSttFailure,
  transcribeTelegramVoiceIntake,
  type TelegramVoiceTranscriber,
  type VoiceTranscript,
} from "./index.js";

const runtimeOptions = {
  callbacks: { onMessage() {} },
  companyId: "fixture-company",
  endpointId: "fixture-endpoint",
  logger: "silent" as const,
  persistence: {
    async read() {
      return null;
    },
    async compareAndSet() {
      return true;
    },
    async deleteIfVersion() {
      return true;
    },
  },
  providerConfig: {
    provider: "telegram" as const,
    userName: "fixture_bot",
    credentials: { botToken: "1:synthetic", secretToken: "synthetic" },
  },
};

/** A runtime-parsed voice attachment with provenance and a stub download. */
function voiceAttachment(input: {
  bytes?: Buffer;
  mimeType?: string;
  size?: number;
  fail?: () => void;
}) {
  const runtime = createChatSdkEndpointRuntime(runtimeOptions);
  const bytes = input.bytes ?? TELEGRAM_VOICE_OGG;
  const raw = {
    message_id: 50,
    date: 1_788_700_000,
    chat: { id: -10077, type: "supergroup" },
    from: { id: 77, is_bot: false, first_name: "Fixture" },
    voice: {
      file_id: "exact-file",
      file_unique_id: "exact-unique",
      file_size: input.size ?? bytes.length,
      duration: 1,
      ...(input.mimeType ? { mime_type: input.mimeType } : {}),
    },
  };
  const message = runtime.parseTelegramCommandMessage(raw)!;
  const attachment = message.attachments[0]!;
  const fetchData = vi.fn(async () => {
    if (input.fail) {
      input.fail();
      throw new Error("download failed");
    }
    return bytes;
  });
  attachment.fetchData = fetchData;
  return { attachment, fetchData, runtime };
}

function transcriber(
  result: VoiceTranscript | Error,
): TelegramVoiceTranscriber {
  return {
    transcribeAudio: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

const enabled = { MYRMIDON_TELEGRAM_VOICE_STT: "1" } as const;
const success: VoiceTranscript = {
  text: "привет, это голосовое",
  segments: undefined,
  language: "ru",
  durationMs: 3000,
  truncated: false,
  backend: "mock",
};

describe("transcribeTelegramVoiceIntake (mock core)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes zero calls with the setting off (guard)", async () => {
    const core = transcriber(success);
    const item = voiceAttachment({});
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "",
        voiceAttachments: [item.attachment],
        env: {},
        transcriber: core,
      });
      expect(outcome.body).toBeNull();
      expect(outcome.skip).toBe("stt_disabled");
      expect(core.transcribeAudio).not.toHaveBeenCalled();
      expect(item.fetchData).not.toHaveBeenCalled();
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("returns stt_unconfigured without a transcriber (core not merged yet)", async () => {
    const item = voiceAttachment({});
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "",
        voiceAttachments: [item.attachment],
        env: enabled,
        transcriber: null,
      });
      expect(outcome.skip).toBe("stt_unconfigured");
      expect(item.fetchData).not.toHaveBeenCalled();
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("identifies a MIME-less voice note from its bytes and composes the body", async () => {
    const core = transcriber(success);
    const item = voiceAttachment({});
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "посмотри",
        voiceAttachments: [item.attachment],
        env: enabled,
        transcriber: core,
      });
      expect(outcome.skip).toBeNull();
      expect(outcome.body).toBe("посмотри\n\nпривет, это голосовое");
      const call = vi.mocked(core.transcribeAudio).mock.calls[0]?.[0];
      expect(call?.companyId).toBe("company-a");
      expect(call?.mimeType).toBe("audio/ogg");
      expect(call && Buffer.from(call.bytes).equals(TELEGRAM_VOICE_OGG)).toBe(true);
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("renders speaker segments through the same renderer", async () => {
    const item = voiceAttachment({});
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "",
        voiceAttachments: [item.attachment],
        env: enabled,
        transcriber: transcriber({
          ...success,
          text: "",
          segments: [
            { speaker: "1", startMs: 0, endMs: 1000, text: "раз" },
            { speaker: "2", startMs: 62000, endMs: 64000, text: "два" },
          ],
        }),
      });
      expect(outcome.body).toBe(
        "Говорящий 1 [0:00]: раз\nГоворящий 2 [1:02]: два",
      );
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("a download failure is a skip, not a delivery failure", async () => {
    const item = voiceAttachment({ fail: () => {} });
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "",
        voiceAttachments: [item.attachment],
        env: enabled,
        transcriber: transcriber(success),
      });
      expect(outcome.body).toBeNull();
      expect(outcome.skip).toBe("stt_upstream_error");
    } finally {
      await item.runtime.shutdown();
    }
  });

  it.each([
    ["stt_timeout", "stt_timeout"],
    ["stt_upstream_error", "stt_upstream_error"],
    ["audio_too_long", "audio_too_long"],
    ["unknown-code", "stt_upstream_error"],
  ] as const)(
    "a core error with code %j is classified as %j",
    async (code, expected) => {
      const item = voiceAttachment({});
      try {
        const error = Object.assign(new Error("sensitive message"), { code });
        const outcome = await transcribeTelegramVoiceIntake({
          companyId: "company-a",
          senderText: "",
          voiceAttachments: [item.attachment],
          env: enabled,
          transcriber: {
            transcribeAudio: vi.fn(async () => {
              throw error;
            }),
          },
        });
        expect(outcome.skip).toBe(expected);
        expect(outcome.body).toBeNull();
      } finally {
        await item.runtime.shutdown();
      }
    },
  );

  it("an oversized declared attachment is skipped before any download", async () => {
    const core = transcriber(success);
    const item = voiceAttachment({ size: 21 * 1024 * 1024 });
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "",
        voiceAttachments: [item.attachment],
        env: enabled,
        transcriber: core,
      });
      expect(outcome.skip).toBe("audio_too_large");
      expect(core.transcribeAudio).not.toHaveBeenCalled();
      expect(item.fetchData).not.toHaveBeenCalled();
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("a transcription timeout is a skip", async () => {
    const item = voiceAttachment({});
    try {
      const slow: TelegramVoiceTranscriber = {
        transcribeAudio: vi.fn(
          () => new Promise<VoiceTranscript>(() => undefined),
        ),
      };
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: "company-a",
        senderText: "",
        voiceAttachments: [item.attachment],
        env: enabled,
        transcriber: slow,
        fetchTimeoutMs: 20,
      });
      expect(outcome.skip).toBe("stt_timeout");
    } finally {
      await item.runtime.shutdown();
    }
  });
});

describe("classifyVoiceSttFailure", () => {
  it("maps the stable core codes onto themselves", () => {
    for (const code of [
      "stt_disabled",
      "stt_unconfigured",
      "audio_too_long",
      "audio_too_large",
      "stt_timeout",
      "stt_upstream_error",
    ])
      expect(classifyVoiceSttFailure({ code })).toBe(code);
  });

  it("everything else is stt_upstream_error", () => {
    expect(classifyVoiceSttFailure(new Error("x"))).toBe("stt_upstream_error");
    expect(classifyVoiceSttFailure(null)).toBe("stt_upstream_error");
    expect(classifyVoiceSttFailure({ code: "whatever" })).toBe(
      "stt_upstream_error",
    );
  });
});
