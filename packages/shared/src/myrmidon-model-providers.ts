// packages/shared/src/myrmidon-model-providers.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS): names, defaults and payload schemas of the
// company model-provider settings API.
//
// Pure data and pure functions only — no addresses, no key values. The server,
// the compiler and the tests read one source of truth:
//
//  - the secret-store NAME a provider credential lives under (derived from the
//    provider row id, so two providers can never collide on one secret and a
//    rename cannot orphan a key);
//  - the default base URL per provider type (a base URL is not a secret);
//  - the request/response contracts of the settings API as zod schemas.
//
// The key value itself is accepted by POST/PATCH, stored in the secret store,
// and NEVER answered back — the API answers `has_key` only.

import { z } from "zod";

/** Prefix of a model-provider credential name in the company secret store. */
export const MODEL_PROVIDER_SECRET_PREFIX = "model-provider-key-";

/** The provider kinds a company may register. */
export const MODEL_PROVIDER_TYPES = [
  "openai",
  "dashscope",
  "google",
  "openai-compatible",
] as const;
export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

/** Default base URL per provider type; null means the provider's own default. */
export const MODEL_PROVIDER_DEFAULT_BASE_URLS: Readonly<
  Record<ModelProviderType, string | null>
> = {
  openai: "https://api.openai.com/v1",
  dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  google: "https://generativelanguage.googleapis.com/v1beta-openai",
  "openai-compatible": null,
};

/** The models-list path every supported provider speaks (OpenAI-compatible). */
export const MODEL_PROVIDER_MODELS_PATH = "/models";

/**
 * The secret-store name that carries one provider's credential.
 *
 * Derived from the provider row id, not its display name: a display name is
 * editable and enforced unique per company, so a rename would orphan the key
 * under a name-derived secret. The id is stable and unique.
 */
export function modelProviderSecretName(providerId: string): string {
  const id = providerId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `${MODEL_PROVIDER_SECRET_PREFIX}${id}`;
}

/** Whether a secret name is one this feature manages. */
export function isModelProviderSecretName(name: string): boolean {
  return name.startsWith(MODEL_PROVIDER_SECRET_PREFIX);
}

/** POST /providers body. `key` is accepted, validated and never echoed back. */
export const createModelProviderSchema = z
  .object({
    type: z.enum(MODEL_PROVIDER_TYPES),
    name: z.string().trim().min(1).max(160),
    baseUrl: z.string().trim().url().max(2048).optional().nullable(),
    key: z.string().min(1).max(4096),
    free: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "openai-compatible" && !value.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "baseUrl is required for an openai-compatible provider",
      });
    }
  });
export type CreateModelProviderInput = z.infer<typeof createModelProviderSchema>;

/** PATCH /providers/{id} body: the rotation (and optional metadata edits). */
export const patchModelProviderSchema = z.object({
  key: z.string().min(1).max(4096).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  baseUrl: z.string().trim().url().max(2048).optional().nullable(),
  free: z.boolean().optional(),
});
export type PatchModelProviderInput = z.infer<typeof patchModelProviderSchema>;

/** POST /providers/{id}/models body: the per-model enable/disable switches. */
export const setModelProviderModelsSchema = z.object({
  models: z
    .array(
      z.object({
        modelName: z.string().trim().min(1).max(512),
        enabled: z.boolean().optional(),
        free: z.boolean().optional(),
      }),
    )
    .max(500),
});
export type SetModelProviderModelsInput = z.infer<typeof setModelProviderModelsSchema>;
