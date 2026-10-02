-- myrmidon(H2): agent instructions bundle revision history.
-- Additive only: one new table + indexes; no vendor table is touched, no data
-- is rewritten. Snapshots the whole instructions bundle per change so any
-- revision can be restored (the run request keeps reading the bundle files).
CREATE TABLE "agent_instructions_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"entry_file" text NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"rolled_back_from_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instructions_revisions_company_agent_created_idx" ON "agent_instructions_revisions" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instructions_revisions_agent_revision_uq" ON "agent_instructions_revisions" USING btree ("agent_id","revision_number");
