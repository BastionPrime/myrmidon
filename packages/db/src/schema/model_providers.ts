// packages/db/src/schema/model_providers.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS): the company model-provider registry and
// its model cache.
//
// One row per provider a company registered (OpenAI, DashScope, Google or any
// OpenAI-compatible endpoint). The provider CREDENTIAL never reaches this
// table: only the name of the company secret that carries it
// (`credential_secret_name`), so the database stays write-only with respect to
// the key value. The API answers `has_key` from the secret store, never the
// value.
//
// `model_provider_models` is the list snapshot captured when the key was
// validated (the provider's /models response), one row per model with the
// litellm model name the gateway will be configured with later (part B of
// MODEL-PROVIDERS). `enabled` is the operator's per-model switch.
//
// Additive migration only: two new tables + indexes, no vendor table touched.

import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** The provider kinds a company may register. */
export const MODEL_PROVIDER_TYPES = [
  "openai",
  "dashscope",
  "google",
  "openai-compatible",
] as const;
export type ModelProviderType = (typeof MODEL_PROVIDER_TYPES)[number];

export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** openai | dashscope | google | openai-compatible */
    type: text("type").$type<ModelProviderType>().notNull(),
    /** Operator-facing name, unique per company. */
    name: text("name").notNull(),
    /** The provider API endpoint; null means "the provider's own default". */
    baseUrl: text("base_url"),
    /**
     * The NAME of the company secret carrying the provider key. The value
     * itself lives only in the secret store and is never read back by the
     * settings API.
     */
    credentialSecretName: text("credential_secret_name"),
    /** Whether the provider is a free-tier or paid provider for this company. */
    free: boolean("free").notNull().default(false),
    /** When the key was last validated against the provider (model list fetch). */
    keyValidatedAt: timestamp("key_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("model_providers_company_name_uq").on(
      table.companyId,
      table.name,
    ),
    companyIdx: index("model_providers_company_idx").on(table.companyId),
  }),
);

export const modelProviderModels = pgTable(
  "model_provider_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    /** The model name as the provider spells it (`gpt-4o`, `qwen-max`). */
    modelName: text("model_name").notNull(),
    /** The model name LiteLLM will be configured with (part B). */
    litellmModelName: text("litellm_model_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    free: boolean("free").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerModelUq: uniqueIndex("model_provider_models_provider_model_uq").on(
      table.providerId,
      table.modelName,
    ),
    providerIdx: index("model_provider_models_provider_idx").on(table.providerId),
  }),
);
