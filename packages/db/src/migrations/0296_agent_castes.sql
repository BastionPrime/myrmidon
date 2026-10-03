-- myrmidon(CUSTOM-CASTES): the company caste (agent role) directory.
-- Additive only: one new table + indexes; no vendor table is touched, no data
-- is rewritten. `agents.role` is NOT migrated: the 12 AGENT_ROLES values stay
-- as they are, the directory seeds itself lazily per company on first read.
CREATE TABLE "agent_castes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ru" text,
	"description" text,
	"color" text DEFAULT 'gray' NOT NULL,
	"icon" text,
	"default_model" text,
	"swarm_eligible" boolean DEFAULT true NOT NULL,
	"max_active_tasks" integer,
	"built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_castes" ADD CONSTRAINT "agent_castes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_castes_company_key_uq" ON "agent_castes" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "agent_castes_company_idx" ON "agent_castes" USING btree ("company_id");
