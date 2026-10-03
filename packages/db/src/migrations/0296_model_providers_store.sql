-- myrmidon(1.6.1 MODEL-PROVIDERS): the company model-provider registry and
-- its model cache. Additive only: two new tables + indexes; no vendor table is
-- touched, no data is rewritten.
-- The provider credential value never reaches the database: the row stores
-- only the NAME of the company secret that carries it (write-only by design).
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"credential_secret_name" text,
	"free" boolean DEFAULT false NOT NULL,
	"key_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_name" text NOT NULL,
	"litellm_model_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"free" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_models" ADD CONSTRAINT "model_provider_models_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_company_name_uq" ON "model_providers" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "model_providers_company_idx" ON "model_providers" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_models_provider_model_uq" ON "model_provider_models" USING btree ("provider_id","model_name");--> statement-breakpoint
CREATE INDEX "model_provider_models_provider_idx" ON "model_provider_models" USING btree ("provider_id");
