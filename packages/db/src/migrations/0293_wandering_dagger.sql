-- myrmidon(1.6-WIKI): company regulations as wiki pages with a lifecycle.
-- Additive only: one new table + indexes; no vendor table is touched, no data
-- is rewritten. One row per regulation; the append-only revision history rides
-- in the `revisions` jsonb column, the newest revision is mirrored into the
-- plain columns (generated with drizzle-kit).
CREATE TABLE "myrmidon_wiki_regulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision_number" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"revisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "myrmidon_wiki_regulations" ADD CONSTRAINT "myrmidon_wiki_regulations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_wiki_regulations_company_slug_uq" ON "myrmidon_wiki_regulations" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "myrmidon_wiki_regulations_company_status_idx" ON "myrmidon_wiki_regulations" USING btree ("company_id","status");