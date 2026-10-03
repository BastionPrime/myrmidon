// myrmidon(1.6.1 VOICE-STT C): the "Speech recognition (STT)" settings screen
// — layout + local interaction state; the wire state (query, mutation) lives
// in VoiceSttContainer.tsx so tests can drive both tiers separately.
//
// Fields (Part A contract): enabled toggle, backend (dashscope|deepgram),
// model name, language (auto|ru), diarization flag, max duration limit, and
// the two secret NAMES (gateway key / Deepgram key) — board-managed company
// secrets whose values live only on the server. The screen renders the names
// and an unset indicator; it never sees a secret value, so nothing value-like
// can reach the DOM (guarded by tests).
import { useEffect, useState } from "react";
import { AudioLines, KeyRound } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  VOICE_STT_BACKENDS,
  VOICE_STT_LANGUAGES,
  type VoiceSttSettings,
  type VoiceSttUpdateInput,
} from "./voiceSttApi";

/** Local editable copy of the settings record; model null → "" for the input. */
export interface VoiceSttFormState {
  enabled: boolean;
  backend: VoiceSttSettings["backend"];
  model: string;
  language: VoiceSttSettings["language"];
  diarization: boolean;
  maxDurationSec: string;
  keySecret: string;
  deepgramKeySecret: string;
}

export function formFromSettings(settings: VoiceSttSettings): VoiceSttFormState {
  return {
    enabled: settings.enabled,
    backend: settings.backend,
    model: settings.model ?? "",
    language: settings.language,
    diarization: settings.diarization,
    maxDurationSec: String(settings.maxDurationSec),
    keySecret: settings.keySecret ?? "",
    deepgramKeySecret: settings.deepgramKeySecret ?? "",
  };
}

/** Diff of the local form against the loaded record: only edited fields are
 * sent on PATCH (the contract sends setting names, never secret values). */
export function diffFromSettings(
  form: VoiceSttFormState,
  settings: VoiceSttSettings,
): VoiceSttUpdateInput {
  const input: VoiceSttUpdateInput = {};
  if (form.enabled !== settings.enabled) input.enabled = form.enabled;
  if (form.backend !== settings.backend) input.backend = form.backend;
  if (form.model !== (settings.model ?? "")) input.model = form.model.trim() || null;
  if (form.language !== settings.language) input.language = form.language;
  if (form.diarization !== settings.diarization) input.diarization = form.diarization;
  const duration = Number.parseInt(form.maxDurationSec, 10);
  if (Number.isFinite(duration) && duration !== settings.maxDurationSec) {
    input.maxDurationSec = duration;
  }
  if (form.keySecret.trim() !== (settings.keySecret ?? "")) {
    input.keySecret = form.keySecret.trim() || null;
  }
  if (form.deepgramKeySecret.trim() !== (settings.deepgramKeySecret ?? "")) {
    input.deepgramKeySecret = form.deepgramKeySecret.trim() || null;
  }
  return input;
}

export function VoiceSttScreenView({
  settings,
  saving,
  error,
  dirty,
  onChange,
  onSave,
}: {
  settings: VoiceSttSettings;
  saving: boolean;
  error: string | null;
  dirty: boolean;
  onChange: (next: VoiceSttFormState) => void;
  onSave: (input: VoiceSttUpdateInput) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<VoiceSttFormState>(() => formFromSettings(settings));

  // Reset the local copy when a fresh record lands after save/reload.
  useEffect(() => {
    setForm(formFromSettings(settings));
  }, [settings]);

  const set = (patch: Partial<VoiceSttFormState>) => {
    const next = { ...form, ...patch };
    setForm(next);
    onChange(next);
  };

  const save = () => {
    onSave(diffFromSettings(form, settings));
  };

  const durationInvalid =
    !/^\d+$/.test(form.maxDurationSec.trim()) || Number.parseInt(form.maxDurationSec, 10) < 1;

  return (
    <div className="max-w-3xl space-y-6" data-testid="myrmidon-voice-stt-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <AudioLines className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("voiceStt.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("voiceStt.intro")}</p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-voice-stt-error">
          {error}
        </p>
      ) : null}

      {/* 1. Enable + backend */}
      <section className="space-y-3" data-testid="myrmidon-voice-stt-general">
        <label className="flex items-center gap-2 text-sm" data-testid="myrmidon-voice-stt-enabled">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          {t("voiceStt.enabled")}
        </label>
        <div className="space-y-1">
          <Label htmlFor="voice-stt-backend">{t("voiceStt.backend")}</Label>
          <select
            id="voice-stt-backend"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={form.backend}
            onChange={(e) => set({ backend: e.target.value as VoiceSttSettings["backend"] })}
            data-testid="myrmidon-voice-stt-backend"
          >
            {VOICE_STT_BACKENDS.map((backend) => (
              <option key={backend} value={backend}>
                {backend}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t("voiceStt.backendHint")}</p>
        </div>
        <label className="flex items-center gap-2 text-sm" data-testid="myrmidon-voice-stt-diarization">
          <input
            type="checkbox"
            checked={form.diarization}
            onChange={(e) => set({ diarization: e.target.checked })}
          />
          {t("voiceStt.diarization")}
        </label>
      </section>

      {/* 2. Model + language */}
      <section className="grid gap-3 md:grid-cols-2" data-testid="myrmidon-voice-stt-model-section">
        <div className="space-y-1">
          <Label htmlFor="voice-stt-model">{t("voiceStt.model")}</Label>
          <Input
            id="voice-stt-model"
            value={form.model}
            placeholder={t("voiceStt.modelPlaceholder")}
            onChange={(e) => set({ model: e.target.value })}
            data-testid="myrmidon-voice-stt-model"
          />
          <p className="text-xs text-muted-foreground">{t("voiceStt.modelHint")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="voice-stt-language">{t("voiceStt.language")}</Label>
          <select
            id="voice-stt-language"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            value={form.language}
            onChange={(e) => set({ language: e.target.value as VoiceSttSettings["language"] })}
            data-testid="myrmidon-voice-stt-language"
          >
            {VOICE_STT_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* 3. Duration limit */}
      <section className="space-y-1" data-testid="myrmidon-voice-stt-limit">
        <Label htmlFor="voice-stt-max-duration">{t("voiceStt.maxDuration")}</Label>
        <Input
          id="voice-stt-max-duration"
          inputMode="numeric"
          value={form.maxDurationSec}
          onChange={(e) => set({ maxDurationSec: e.target.value })}
          data-testid="myrmidon-voice-stt-max-duration"
        />
        <p className="text-xs text-muted-foreground">{t("voiceStt.maxDurationHint")}</p>
      </section>

      {/* 4. Secret names — values never travel to this screen */}
      <section className="grid gap-3 md:grid-cols-2" data-testid="myrmidon-voice-stt-secrets">
        <div className="space-y-1">
          <Label htmlFor="voice-stt-key-secret">
            <span className="inline-flex items-center gap-1">
              <KeyRound className="h-3 w-3" aria-hidden="true" />
              {t("voiceStt.keySecret")}
            </span>
          </Label>
          <Input
            id="voice-stt-key-secret"
            value={form.keySecret}
            placeholder={t("voiceStt.keySecretPlaceholder")}
            onChange={(e) => set({ keySecret: e.target.value })}
            data-testid="myrmidon-voice-stt-key-secret"
          />
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-voice-stt-key-secret-state">
            {settings.keySecret ? t("voiceStt.secretSet") : t("voiceStt.secretUnset")}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="voice-stt-deepgram-secret">
            <span className="inline-flex items-center gap-1">
              <KeyRound className="h-3 w-3" aria-hidden="true" />
              {t("voiceStt.deepgramKeySecret")}
            </span>
          </Label>
          <Input
            id="voice-stt-deepgram-secret"
            value={form.deepgramKeySecret}
            placeholder={t("voiceStt.keySecretPlaceholder")}
            onChange={(e) => set({ deepgramKeySecret: e.target.value })}
            data-testid="myrmidon-voice-stt-deepgram-secret"
          />
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-voice-stt-deepgram-secret-state">
            {settings.deepgramKeySecret ? t("voiceStt.secretSet") : t("voiceStt.secretUnset")}
          </p>
        </div>
        <p className="text-xs text-muted-foreground md:col-span-2">{t("voiceStt.secretHint")}</p>
      </section>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={save}
          disabled={saving || !dirty || durationInvalid}
          data-testid="myrmidon-voice-stt-save"
        >
          {saving ? t("voiceStt.saving") : t("voiceStt.save")}
        </Button>
      </div>
    </div>
  );
}
