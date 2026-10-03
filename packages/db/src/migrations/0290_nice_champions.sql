CREATE TABLE "foraging_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"summary" text NOT NULL,
	"diff" jsonb NOT NULL,
	"skill_key" text NOT NULL,
	"candidate_ref" text,
	"reason" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foraging_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"url" text NOT NULL,
	"kind" text DEFAULT 'url' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_snapshot" jsonb,
	"last_snapshot_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "foraging_findings" ADD CONSTRAINT "foraging_findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foraging_findings" ADD CONSTRAINT "foraging_findings_source_id_foraging_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."foraging_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foraging_sources" ADD CONSTRAINT "foraging_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "foraging_findings_company_detected_idx" ON "foraging_findings" USING btree ("company_id","detected_at");--> statement-breakpoint
CREATE INDEX "foraging_findings_company_status_idx" ON "foraging_findings" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "foraging_findings_source_idx" ON "foraging_findings" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "foraging_sources_company_role_url_uq" ON "foraging_sources" USING btree ("company_id","role","url");--> statement-breakpoint
CREATE INDEX "foraging_sources_company_role_idx" ON "foraging_sources" USING btree ("company_id","role");