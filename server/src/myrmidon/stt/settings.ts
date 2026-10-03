// server/src/myrmidon/stt/settings.ts
//
// myrmidon(1.6.1 VOICE-STT A1): where the STT path gets its backend and its
// limits, and how the board's runtime overrides meet the environment
// defaults.
//
// The instance names the STT contour the same way the OCR path does
// (myrmidon(EXT-CASE-OCR)): an address, the *name* of the company secret that
// holds the key, and the model. The key value is never part of a setting —
// it is read from the company's secrets at call time, so it is never cached,
// never logged and never journaled.
//
// Unset (the default) means the path is off: a producer asking for
// `transcribeAudio` gets a stable `stt_disabled` and no outbound request is
// made at all.
//
// The runtime-mutable part (enabled, backend, model, language, diarization,
// duration limit) lives per company in the instance_settings JSON column
// (key `myrmidonStt`, the same no-migration pattern the autonomy matrix
// uses); the environment values are the defaults it starts from.

export const STT_ENABLED_ENV = "MYRMIDON_STT_ENABLED";
export const STT_BACKEND_ENV = "MYRMIDON_STT_BACKEND";
export const STT_BASE_URL_ENV = "MYRMIDON_STT_BASE_URL";
/** Name of the company secret holding the gateway key for the DashScope path. */
export const STT_KEY_SECRET_ENV = "MYRMIDON_STT_KEY_SECRET";
/** Name of the company secret holding the Deepgram key. */
export const STT_DEEPGRAM_KEY_SECRET_ENV = "MYRMIDON_STT_DEEPGRAM_KEY_SECRET";
export const STT_MODEL_ENV = "MYRMIDON_STT_MODEL";
export const STT_LANGUAGE_ENV = "MYRMIDON_STT_LANGUAGE";
export const STT_DIARIZATION_ENV = "MYRMIDON_STT_DIARIZATION";
export const STT_MAX_DURATION_SEC_ENV = "MYRMIDON_STT_MAX_DURATION_SEC";
export const STT_TIMEOUT_SEC_ENV = "MYRMIDON_STT_TIMEOUT_SEC";
/** Chunk duration of the long-recording split, seconds. */
export const STT_CHUNK_SEC_ENV = "MYRMIDON_STT_CHUNK_SEC";
export const STT_MAX_BYTES_ENV = "MYRMIDON_STT_MAX_BYTES";

export type SttBackendKind = "dashscope" | "deepgram";
export type SttLanguage = "auto" | "ru";

export const DEFAULT_STT_BACKEND: SttBackendKind = "dashscope";
export const DEFAULT_STT_LANGUAGE: SttLanguage = "auto";
export const DEFAULT_STT_MAX_DURATION_SEC = 1800; // 30 minutes
export const DEFAULT_STT_TIMEOUT_SEC = 120;
export const DEFAULT_STT_CHUNK_SEC = 60;
export const DEFAULT_STT_MAX_BYTES = 25 * 1024 * 1024;

const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 600;
const MIN_CHUNK_SEC = 5;
const MAX_CHUNK_SEC = 300;

export interface SttSettings {
  /** Off unless the contour is named and the master switch allows it. */
  enabled: boolean;
  backend: SttBackendKind;
  /** Address of the gateway (DashScope path) or of Deepgram. */
  baseUrl: string | null;
  /** Company secret name holding the key of the active backend. */
  keySecret: string | null;
  /** Model name on the gateway; null until an operator registers one. */
  model: string | null;
  language: SttLanguage;
  diarization: boolean;
  maxDurationSec: number;
  timeoutMs: number;
  /** Target duration of one chunk of the long-recording split, seconds. */
  chunkSec: number;
  maxBytes: number;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return null;
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0 || value > max) return fallback;
  return value;
}

/**
 * The settings an instance runs the STT path with, read from the environment.
 *
 * The master switch (`MYRMIDON_STT_ENABLED`) is the only way to turn the path
 * on: without it every call degrades to `stt_disabled` before any key is read
 * or any request is attempted. An unusable value elsewhere (an unknown backend
 * name, a non-integer limit) falls back to the default instead of disabling
 * the path — an operator typo in a limit must not silently switch STT off.
 */
export function sttSettings(env: NodeJS.ProcessEnv = process.env): SttSettings {
  const enabled = readBool(env[STT_ENABLED_ENV]) ?? false;
  const baseUrl = env[STT_BASE_URL_ENV]?.trim() || null;
  const rawBackend = env[STT_BACKEND_ENV]?.trim().toLowerCase();
  const backend: SttBackendKind =
    rawBackend === "dashscope" || rawBackend === "deepgram" ? rawBackend : DEFAULT_STT_BACKEND;
  const keySecret =
    (backend === "deepgram"
      ? env[STT_DEEPGRAM_KEY_SECRET_ENV]?.trim() || env[STT_KEY_SECRET_ENV]?.trim()
      : env[STT_KEY_SECRET_ENV]?.trim()) || null;
  const rawLanguage = env[STT_LANGUAGE_ENV]?.trim().toLowerCase();
  const language: SttLanguage = rawLanguage === "ru" || rawLanguage === "auto" ? rawLanguage : DEFAULT_STT_LANGUAGE;
  const timeoutSec = readPositiveInt(env[STT_TIMEOUT_SEC_ENV], DEFAULT_STT_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
  const chunkSec = readPositiveInt(env[STT_CHUNK_SEC_ENV], DEFAULT_STT_CHUNK_SEC, MAX_CHUNK_SEC);
  return {
    enabled,
    backend,
    baseUrl,
    keySecret,
    model: env[STT_MODEL_ENV]?.trim() || null,
    language,
    diarization: readBool(env[STT_DIARIZATION_ENV]) ?? false,
    maxDurationSec: readPositiveInt(env[STT_MAX_DURATION_SEC_ENV], DEFAULT_STT_MAX_DURATION_SEC, Number.MAX_SAFE_INTEGER),
    timeoutMs: Math.max(timeoutSec, MIN_TIMEOUT_SEC) * 1000,
    chunkSec: Math.min(Math.max(chunkSec, MIN_CHUNK_SEC), MAX_CHUNK_SEC),
    maxBytes: readPositiveInt(env[STT_MAX_BYTES_ENV], DEFAULT_STT_MAX_BYTES, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * Why the path cannot serve a call, or null when it can. The message names
 * the settings, never a value, so it is safe to hand to a bot and to the log.
 *
 * A missing model on the DashScope path is `stt_unconfigured`, not
 * `stt_disabled`: the gateway is live but the recognition model is not
 * registered yet (the operator's action, not a setting of this instance), so
 * the code stays stable while the model lands.
 */
export function sttSettingsProblem(settings: SttSettings): SttProblem | null {
  if (!settings.enabled) {
    return { code: "stt_disabled", message: `STT is disabled: set ${STT_ENABLED_ENV} to enable it` };
  }
  if (!settings.baseUrl || !settings.keySecret) {
    const missing = [
      settings.baseUrl ? null : STT_BASE_URL_ENV,
      settings.keySecret ? null : sttKeySecretEnvName(settings),
    ].filter((name): name is string => name !== null);
    return {
      code: "stt_unconfigured",
      message: `STT is not configured on this instance: set ${missing.join(" and ")}`,
    };
  }
  if (settings.backend === "dashscope" && !settings.model) {
    return {
      code: "stt_unconfigured",
      message: `STT is not configured on this instance: set ${STT_MODEL_ENV} to the gateway model name`,
    };
  }
  return null;
}

export interface SttProblem {
  code: "stt_disabled" | "stt_unconfigured";
  message: string;
}

/**
 * The env variable name that names the key secret of the active backend —
 * for messages only; the value never appears in one.
 */
export function sttKeySecretEnvName(settings: SttSettings): string {
  return settings.backend === "deepgram" ? STT_DEEPGRAM_KEY_SECRET_ENV : STT_KEY_SECRET_ENV;
}

/**
 * Resolves the effective settings for one company: the stored runtime
 * overrides (the `myrmidonStt` document) on top of the environment defaults.
 *
 * `null` fields in the stored document mean "inherit the environment". A
 * stored `enabled: true` cannot resurrect a path whose contour is unnamed:
 * the result still degrades to `stt_unconfigured` until the address and the
 * key secret are set.
 */
export function resolveSttSettings(base: SttSettings, overrides: Partial<StoredSttOverrides> | null): SttSettings {
  if (!overrides) return base;
  const merged: SttSettings = {
    ...base,
    enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : base.enabled,
    backend: overrides.backend === "deepgram" || overrides.backend === "dashscope" ? overrides.backend : base.backend,
    model: overrides.model === undefined || overrides.model === null ? base.model : overrides.model,
    language: overrides.language === "ru" || overrides.language === "auto" ? overrides.language : base.language,
    diarization: typeof overrides.diarization === "boolean" ? overrides.diarization : base.diarization,
    maxDurationSec:
      typeof overrides.maxDurationSec === "number" && Number.isInteger(overrides.maxDurationSec) && overrides.maxDurationSec > 0
        ? overrides.maxDurationSec
        : base.maxDurationSec,
  };
  return merged;
}

/** The runtime-mutable fields a board PATCH may change, stored per company. */
export interface StoredSttOverrides {
  enabled: boolean;
  backend: SttBackendKind;
  /** null — explicit "inherit the environment default"; undefined — field not stored. */
  model: string | null;
  language: SttLanguage;
  diarization: boolean;
  maxDurationSec: number;
}
