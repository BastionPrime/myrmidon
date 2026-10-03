// myrmidon(1.6.1 VOICE-STT C): API client for the "Speech recognition (STT)"
// company settings screen. Speaks the Part A contract (branch
// myr/1.6.1-voice-stt-core) against /api/myrmidon/companies/:id/voice-stt:
//   GET   → the full settings record
//   PATCH → the same record fields (write)
// The keys are board-managed company secrets stored on the server: the API
// carries only the secret NAMES (never values), so the wire types below are
// value-free by construction.
import { api } from "@/api/client";

export const VOICE_STT_BACKENDS = ["dashscope", "deepgram"] as const;
export type VoiceSttBackend = (typeof VOICE_STT_BACKENDS)[number];

export const VOICE_STT_LANGUAGES = ["auto", "ru"] as const;
export type VoiceSttLanguage = (typeof VOICE_STT_LANGUAGES)[number];

/** Settings record — the GET response and the PATCH write body (Part A
 * contract, fixed): every field is a plain setting; the key fields carry the
 * secret NAME only, never the value. */
export interface VoiceSttSettings {
  enabled: boolean;
  backend: VoiceSttBackend;
  model: string | null;
  language: VoiceSttLanguage;
  diarization: boolean;
  maxDurationSec: number;
  keySecret: string | null;
  deepgramKeySecret: string | null;
}

/** PATCH input — the mutable screen fields. The secret-name fields are
 * omitted when unchanged (send only what the user edited). */
export type VoiceSttUpdateInput = Partial<
  Pick<
    VoiceSttSettings,
    | "enabled"
    | "backend"
    | "model"
    | "language"
    | "diarization"
    | "maxDurationSec"
    | "keySecret"
    | "deepgramKeySecret"
  >
>;

export const voiceSttQueryKey = (companyId: string) =>
  ["myrmidon", "voice-stt", companyId] as const;

export const voiceSttApi = {
  /** GET /voice-stt → the settings record (secret names only, never values). */
  view: (companyId: string) =>
    api.get<VoiceSttSettings>(`/myrmidon/companies/${encodeURIComponent(companyId)}/voice-stt`),

  /** PATCH /voice-stt — write the changed setting fields. */
  update: (companyId: string, input: VoiceSttUpdateInput) =>
    api.patch<VoiceSttSettings>(`/myrmidon/companies/${encodeURIComponent(companyId)}/voice-stt`, input),
};
