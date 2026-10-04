// server/src/myrmidon/stt/index.ts
//
// myrmidon(1.6.1 VOICE-STT A1): the entry point of the STT path.
//
// Two surfaces:
//
//   - `transcribeAudio` — the in-process contract the producers call (the
//     Telegram voice/audio intake, part B; the meeting-minutes flow, part C).
//     The runtime resolves the contour per call: environment defaults,
//     per-company stored overrides, the key from the company's secrets (by
//     name, never from a setting). Nothing is cached between calls, so a
//     rotation or a settings change takes effect on the next call without a
//     restart.
//   - `GET/PATCH /api/myrmidon/companies/:companyId/voice-stt` — the
//     board-managed runtime settings of one company (GET company access,
//     PATCH board only). The response carries the effective settings and the
//     stable codes the callers degrade to, never a key value.
//
// Mutations are journaled into the activity log with metadata only.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import { assertCompanyAccess, assertBoard, getActorInfo } from "../../routes/authz.js";
import { validate } from "../../middleware/validate.js";
import {
  sttSettings,
  sttSettingsProblem,
  resolveSttSettings,
  type SttSettings,
  type StoredSttOverrides,
} from "./settings.js";
import { mutateSttOverrides, readSttOverrides } from "./store.js";
import { transcribeAudioWithMetadata } from "./service.js";
import { SttError, type SttAudioMime, type SttResult } from "./types.js";

export { sttSettings } from "./settings.js";
export { transcribeAudio } from "./service.js";
export type { SttSettings } from "./settings.js";
export type { SttResult, SttSegment, SttAudioMime, SttErrorCode } from "./types.js";
export { SttError } from "./types.js";

export interface SttRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  db?: Db;
}

export interface SttRuntime {
  settings(companyId: string): Promise<SttSettings>;
  transcribe(companyId: string, input: TranscribeRequest): Promise<SttResult>;
}

export interface TranscribeRequest {
  bytes: Uint8Array;
  mimeType: SttAudioMime;
  durationSec?: number;
}

export function createSttRuntime(options: SttRuntimeOptions): SttRuntime {
  const env = options.env ?? process.env;
  const base = sttSettings(env);
  const fetchImpl = options.fetch ?? fetch;
  const db = options.db;

  const settingsFor = async (companyId: string): Promise<SttSettings> => {
    const overrides = db ? await readSttOverrides(db, companyId) : null;
    return resolveSttSettings(base, overrides);
  };

  return {
    settings: settingsFor,
    async transcribe(companyId: string, input: TranscribeRequest): Promise<SttResult> {
      const settings = await settingsFor(companyId);
      const secrets = db ? secretService(db) : null;
      return (
        await transcribeAudioWithMetadata(
          { companyId, bytes: input.bytes, mimeType: input.mimeType, durationSec: input.durationSec },
          {
            settings,
            fetch: fetchImpl,
            readCompanyKey: async (companyId, secretName) => {
              if (!secrets) return null;
              const row = await secrets.getByName(companyId, secretName);
              if (!row) return null;
              return secrets.resolveSecretValue(companyId, row.id, "latest");
            },
          },
        )
      ).result;
    },
  };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    backend: z.enum(["dashscope", "deepgram"]).optional(),
    model: z.string().min(1).nullable().optional(),
    language: z.enum(["auto", "ru"]).optional(),
    diarization: z.boolean().optional(),
    maxDurationSec: z.number().int().positive().max(86400).optional(),
    keySecret: z.string().min(1).nullable().optional(),
    deepgramKeySecret: z.string().min(1).nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
  })
  .strict();

/** The effective settings view: settings names and stable codes, never a key value. */
function settingsView(settings: SttSettings) {
  const problem = sttSettingsProblem(settings);
  return {
    enabled: settings.enabled,
    backend: settings.backend,
    baseUrl: settings.baseUrl,
    model: settings.model,
    language: settings.language,
    diarization: settings.diarization,
    maxDurationSec: settings.maxDurationSec,
    keySecret: settings.keySecret,
    deepgramKeySecret: settings.deepgramKeySecret,
    problem: problem ? { code: problem.code, message: problem.message } : null,
  };
}

export function myrmidonSttRoutes(
  db: Db,
  runtime: SttRuntime = createSttRuntime({ db }),
  store: { readSttOverrides?: typeof readSttOverrides; mutateSttOverrides?: typeof mutateSttOverrides } = {},
) {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/voice-stt";
  const readOverrides = store.readSttOverrides ?? ((db2: Parameters<typeof readSttOverrides>[0], companyId: string) => readSttOverrides(db2, companyId));
  const writeOverrides = store.mutateSttOverrides ?? ((db2: Parameters<typeof mutateSttOverrides>[0], companyId: string, change: Parameters<typeof mutateSttOverrides>[2]) => mutateSttOverrides(db2, companyId, change));

  router.get(base, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const settings = await runtime.settings(companyId);
    res.json(settingsView(settings));
  });

  router.patch(base, validate(patchSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = req.body as z.infer<typeof patchSchema>;
    const { doc: stored } = await writeOverrides(db, companyId, (current) => {
      // Explicit null clears the stored field — back to the environment default.
      const next: StoredSttOverrides = {
        enabled: body.enabled ?? current?.enabled ?? false,
        backend: body.backend ?? current?.backend ?? "dashscope",
        model: body.model === undefined ? (current?.model ?? null) : body.model,
        language: body.language ?? current?.language ?? "auto",
        diarization: body.diarization ?? current?.diarization ?? false,
        maxDurationSec: body.maxDurationSec ?? current?.maxDurationSec ?? 1800,
        baseUrl: body.baseUrl === undefined ? (current?.baseUrl ?? null) : body.baseUrl,
        keySecret: body.keySecret === undefined ? (current?.keySecret ?? null) : body.keySecret,
        deepgramKeySecret: body.deepgramKeySecret === undefined ? (current?.deepgramKeySecret ?? null) : body.deepgramKeySecret,
      };
      return { next, result: null };
    });
    const actor = getActorInfo(req);
    try {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "myrmidon.stt.settings_saved",
        entityType: "stt_settings",
        entityId: companyId,
        details: { stored },
      });
    } catch {
      // A failed journal entry must not lose a saved setting; the next
      // mutation journals again.
    }
    const settings = await runtime.settings(companyId);
    res.json(settingsView(settings));
  });

  return router;
}
