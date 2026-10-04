// myrmidon(1.6.1 VOICE-STT A1): the service over a fake fetch — the guard
// suite of the path.
//
// The first block is the guard the ticket asks for: settings off ->
// `stt_disabled` and ZERO outbound requests (asserted on the mock fetch,
// which is also asserted to never have been created). The same zero-request
// guarantee pins the unconfigured contour and the missing key secret.
//
// The rest pins: the limits fire before any request; a long recording is
// split and the per-chunk results are merged with offsets; a model-name
// rejection from the gateway degrades to `stt_unconfigured`; the key value
// never appears in any error message.

import { describe, expect, it, vi } from "vitest";
import { transcribeAudioWithMetadata } from "./service.js";
import { sttSettings, STT_ENABLED_ENV, STT_BASE_URL_ENV, STT_KEY_SECRET_ENV, STT_MODEL_ENV } from "./settings.js";
import { buildOggOpus } from "./testbytes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const KEY_VALUE = "company-key-value";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function configuredEnv(): NodeJS.ProcessEnv {
  return {
    [STT_ENABLED_ENV]: "1",
    [STT_BASE_URL_ENV]: "http://gateway.example.com",
    [STT_KEY_SECRET_ENV]: "stt-key",
    [STT_MODEL_ENV]: "stt-model",
  };
}

function deps(overrides: Partial<Parameters<typeof transcribeAudioWithMetadata>[1]> = {}) {
  const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "recognized text" }));
  return {
    fetchImpl,
    deps: {
      settings: sttSettings(configuredEnv()),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
      ...overrides,
    },
  };
}

const INPUT = {
  companyId: COMPANY_ID,
  bytes: buildOggOpus(2),
  mimeType: "audio/ogg" as const,
};

describe("guard: settings off means zero outbound requests", () => {
  it("answers stt_disabled and never calls fetch when the path is off", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "never" }));
    await expect(
      transcribeAudioWithMetadata(INPUT, {
        settings: sttSettings({}),
        fetch: fetchImpl,
        readCompanyKey: vi.fn(async () => KEY_VALUE),
      }),
    ).rejects.toMatchObject({ code: "stt_disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers stt_unconfigured without a request when the model is not named", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "never" }));
    await expect(
      transcribeAudioWithMetadata(INPUT, {
        settings: sttSettings({ [STT_ENABLED_ENV]: "1", [STT_BASE_URL_ENV]: "http://gateway.example.com", [STT_KEY_SECRET_ENV]: "stt-key" }),
        fetch: fetchImpl,
        readCompanyKey: vi.fn(async () => KEY_VALUE),
      }),
    ).rejects.toMatchObject({ code: "stt_unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers stt_unconfigured without a request when the key secret is missing", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "never" }));
    await expect(
      transcribeAudioWithMetadata(INPUT, {
        settings: sttSettings(configuredEnv()),
        fetch: fetchImpl,
        readCompanyKey: vi.fn(async () => null),
      }),
    ).rejects.toMatchObject({ code: "stt_unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const message = (await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv()),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => null),
    }).catch((caught) => caught as { message: string })) as unknown as { message: string };
    expect(message.message).toContain("stt-key");
    expect(message.message).not.toContain(KEY_VALUE);
  });
});

describe("limits fire before any request", () => {
  it("audio_too_long from the producer's duration", async () => {
    const { fetchImpl, deps: serviceDeps } = deps();
    await expect(
      transcribeAudioWithMetadata({ ...INPUT, durationSec: 3600 }, serviceDeps),
    ).rejects.toMatchObject({ code: "audio_too_long" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("audio_too_long from the container's own estimate", async () => {
    const { fetchImpl, deps: serviceDeps } = deps({
      settings: sttSettings({ ...configuredEnv(), MYRMIDON_STT_MAX_DURATION_SEC: "1" }),
    });
    // 3 pages x 500 ms = 1.5 s, over the 1 s limit, with no producer duration.
    await expect(
      transcribeAudioWithMetadata({ ...INPUT, bytes: buildOggOpus(3) }, serviceDeps),
    ).rejects.toMatchObject({
      code: "audio_too_long",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("audio_too_large from the byte size", async () => {
    const { fetchImpl, deps: serviceDeps } = deps({
      settings: sttSettings({ ...configuredEnv(), MYRMIDON_STT_MAX_BYTES: "10" }),
    });
    await expect(transcribeAudioWithMetadata(INPUT, serviceDeps)).rejects.toMatchObject({
      code: "audio_too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the long-recording split through the service", () => {
  it("splits, transcribes each chunk once and merges the offsets", async () => {
    let call = 0;
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      call++;
      return jsonResponse({
        text: `текст ${call}`,
        // OpenAI-style seconds; the backend converts to milliseconds.
        segments: [{ start: 0, end: 0.9, text: `текст ${call}` }],
      });
    });
    // 50 pages x 500 ms = 25 s; the env clamp keeps chunkSec >= 5 s, so a
    // 5 s chunk yields 5 calls.
    const outcome = await transcribeAudioWithMetadata(
      { ...INPUT, bytes: buildOggOpus(50) },
      {
        settings: sttSettings({ ...configuredEnv(), MYRMIDON_STT_CHUNK_SEC: "5" }),
        fetch: fetchImpl,
        readCompanyKey: vi.fn(async () => KEY_VALUE),
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(outcome.metadata.chunks).toBe(5);
    expect(outcome.result.text).toBe("текст 1 текст 2 текст 3 текст 4 текст 5");
    expect(outcome.result.segments!.map((segment) => segment.startMs)).toEqual([0, 5000, 10000, 15000, 20000]);
    expect(outcome.result.truncated).toBe(false);
    expect(outcome.result.backend).toBe("dashscope");
  });

  it("sends an unparseable container whole in one call and marks it", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ text: "текст" }));
    const bytes = new Uint8Array(64).fill(0x00);
    const outcome = await transcribeAudioWithMetadata(
      { ...INPUT, bytes, durationSec: 30 },
      {
        settings: sttSettings(configuredEnv()),
        fetch: fetchImpl,
        readCompanyKey: vi.fn(async () => KEY_VALUE),
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.metadata.unparseableContainer).toBe(true);
    expect(outcome.result.durationMs).toBe(30_000);
  });
});

describe("upstream degradations", () => {
  it("degrades a gateway model-name rejection to stt_unconfigured", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse({ error: { message: "Invalid model name stt-model" } }, 400),
    );
    await expect(
      transcribeAudioWithMetadata(INPUT, {
        settings: sttSettings(configuredEnv()),
        fetch: fetchImpl,
        readCompanyKey: vi.fn(async () => KEY_VALUE),
      }),
    ).rejects.toMatchObject({ code: "stt_unconfigured" });
  });

  it("reports an upstream error with the status, never the key value", async () => {
    const echoed = `upstream echoed: ${KEY_VALUE}`;
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response(echoed, { status: 502 }));
    const error = (await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv()),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    }).catch((caught) => caught as { code: string; message: string })) as { code: string; message: string };
    expect(error.code).toBe("stt_upstream_error");
    expect(error.message).toContain("502");
    expect(error.message).not.toContain(KEY_VALUE);
  });

  it("maps a timeout to stt_timeout without the key value", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new DOMException("aborted", "TimeoutError");
    });
    const error = (await transcribeAudioWithMetadata(INPUT, {
      settings: sttSettings(configuredEnv()),
      fetch: fetchImpl,
      readCompanyKey: vi.fn(async () => KEY_VALUE),
    }).catch((caught) => caught as { code: string; message: string })) as { code: string; message: string };
    expect(error.code).toBe("stt_timeout");
    expect(error.message).not.toContain(KEY_VALUE);
  });
});
