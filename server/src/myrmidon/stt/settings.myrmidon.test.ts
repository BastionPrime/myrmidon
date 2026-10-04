// myrmidon(1.6.1 VOICE-STT A1): settings resolution and degradation codes.
//
// Pins: the path is off by default and says exactly which variable turns it
// on; a typo falls back to the default instead of disabling; the runtime
// overrides sit on top of the environment defaults; a stored `enabled: true`
// cannot resurrect an unnamed contour.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STT_BACKEND,
  DEFAULT_STT_CHUNK_SEC,
  DEFAULT_STT_LANGUAGE,
  DEFAULT_STT_MAX_DURATION_SEC,
  STT_BACKEND_ENV,
  STT_BASE_URL_ENV,
  STT_CHUNK_SEC_ENV,
  STT_DEEPGRAM_KEY_SECRET_ENV,
  STT_DIARIZATION_ENV,
  STT_ENABLED_ENV,
  STT_KEY_SECRET_ENV,
  STT_LANGUAGE_ENV,
  STT_MAX_DURATION_SEC_ENV,
  STT_MODEL_ENV,
  STT_TIMEOUT_SEC_ENV,
  resolveSttSettings,
  sttSettings,
  sttSettingsProblem,
} from "./settings.js";

describe("sttSettings", () => {
  it("is off by default, with no contour named", () => {
    const settings = sttSettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.backend).toBe(DEFAULT_STT_BACKEND);
    expect(settings.baseUrl).toBeNull();
    expect(settings.keySecret).toBeNull();
    expect(settings.model).toBeNull();
    expect(settings.language).toBe(DEFAULT_STT_LANGUAGE);
    expect(settings.diarization).toBe(false);
    expect(settings.maxDurationSec).toBe(DEFAULT_STT_MAX_DURATION_SEC);
  });

  it("degrades to stt_disabled with the variable named in the message", () => {
    const problem = sttSettingsProblem(sttSettings({}));
    expect(problem).toMatchObject({ code: "stt_disabled" });
    expect(problem!.message).toContain(STT_ENABLED_ENV);
  });

  it("names the contour variables when enabled but unconfigured", () => {
    const settings = sttSettings({ [STT_ENABLED_ENV]: "1" });
    const problem = sttSettingsProblem(settings);
    expect(problem).toMatchObject({ code: "stt_unconfigured" });
    expect(problem!.message).toContain(STT_BASE_URL_ENV);
    expect(problem!.message).toContain(STT_KEY_SECRET_ENV);
  });

  it("reports a missing model as stt_unconfigured, not disabled", () => {
    const settings = sttSettings({
      [STT_ENABLED_ENV]: "1",
      [STT_BASE_URL_ENV]: "http://gateway.example.com",
      [STT_KEY_SECRET_ENV]: "stt-key",
    });
    const problem = sttSettingsProblem(settings);
    expect(problem).toMatchObject({ code: "stt_unconfigured" });
    expect(problem!.message).toContain(STT_MODEL_ENV);
  });

  it("uses the deepgram secret name for the deepgram backend", () => {
    const settings = sttSettings({
      [STT_ENABLED_ENV]: "1",
      [STT_BACKEND_ENV]: "deepgram",
      [STT_BASE_URL_ENV]: "https://api.deepgram.com/v1/listen",
      [STT_DEEPGRAM_KEY_SECRET_ENV]: "deepgram-key",
    });
    expect(settings.keySecret).toBe("deepgram-key");
    expect(sttSettingsProblem(settings)).toBeNull();
  });

  it("falls back to defaults on typos instead of disabling the path", () => {
    const settings = sttSettings({
      [STT_ENABLED_ENV]: "true",
      [STT_BACKEND_ENV]: "deepegram",
      [STT_BASE_URL_ENV]: "http://gateway.example.com",
      [STT_KEY_SECRET_ENV]: "stt-key",
      [STT_MODEL_ENV]: "stt-model",
      [STT_LANGUAGE_ENV]: "de",
      [STT_MAX_DURATION_SEC_ENV]: "not-a-number",
      [STT_TIMEOUT_SEC_ENV]: "-5",
      [STT_CHUNK_SEC_ENV]: "0",
    });
    expect(settings.enabled).toBe(true);
    expect(settings.backend).toBe("dashscope");
    expect(settings.language).toBe("auto");
    expect(settings.maxDurationSec).toBe(DEFAULT_STT_MAX_DURATION_SEC);
    expect(settings.timeoutMs).toBe(120_000);
    expect(settings.chunkSec).toBe(DEFAULT_STT_CHUNK_SEC);
  });

  it("reads diarization and language when set", () => {
    const settings = sttSettings({
      [STT_ENABLED_ENV]: "1",
      [STT_BACKEND_ENV]: "deepgram",
      [STT_BASE_URL_ENV]: "https://api.deepgram.com/v1/listen",
      [STT_DEEPGRAM_KEY_SECRET_ENV]: "deepgram-key",
      [STT_DIARIZATION_ENV]: "true",
      [STT_LANGUAGE_ENV]: "ru",
    });
    expect(settings.diarization).toBe(true);
    expect(settings.language).toBe("ru");
  });
});

describe("resolveSttSettings", () => {
  const base = sttSettings({
    [STT_ENABLED_ENV]: "1",
    [STT_BASE_URL_ENV]: "http://gateway.example.com",
    [STT_KEY_SECRET_ENV]: "stt-key",
    [STT_MODEL_ENV]: "stt-model",
  });

  it("returns the base settings when nothing is stored", () => {
    expect(resolveSttSettings(base, null)).toEqual(base);
  });

  it("applies the stored overrides on top of the environment defaults", () => {
    const merged = resolveSttSettings(base, {
      enabled: true,
      backend: "deepgram",
      model: "other-model",
      language: "ru",
      diarization: true,
      maxDurationSec: 600,
    });
    expect(merged.backend).toBe("deepgram");
    expect(merged.model).toBe("other-model");
    expect(merged.language).toBe("ru");
    expect(merged.diarization).toBe(true);
    expect(merged.maxDurationSec).toBe(600);
  });

  it("keeps the environment value for a field the document does not name", () => {
    const merged = resolveSttSettings(base, {
      enabled: true,
      backend: "dashscope",
      model: null,
      language: "auto",
      diarization: false,
      maxDurationSec: 900,
    });
    expect(merged.model).toBe("stt-model"); // null = inherit the environment
  });

  it("cannot enable a path whose contour is unnamed", () => {
    const off = sttSettings({});
    const merged = resolveSttSettings(off, {
      enabled: true,
      backend: "dashscope",
      model: "stt-model",
      language: "auto",
      diarization: false,
      maxDurationSec: 1800,
    });
    expect(merged.enabled).toBe(true);
    expect(merged.baseUrl).toBeNull();
    expect(sttSettingsProblem(merged)).toMatchObject({ code: "stt_unconfigured" });
  });
});
