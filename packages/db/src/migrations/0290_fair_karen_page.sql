CREATE TABLE "company_skill_lifecycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"verified_version_id" uuid,
	"previous_verified_version_id" uuid,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_skill_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"version_id" uuid,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"approval_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle" ADD CONSTRAINT "company_skill_lifecycle_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle" ADD CONSTRAINT "company_skill_lifecycle_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle" ADD CONSTRAINT "company_skill_lifecycle_verified_version_id_company_skill_versions_id_fk" FOREIGN KEY ("verified_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle" ADD CONSTRAINT "company_skill_lifecycle_previous_verified_version_id_company_skill_versions_id_fk" FOREIGN KEY ("previous_verified_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle_events" ADD CONSTRAINT "company_skill_lifecycle_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle_events" ADD CONSTRAINT "company_skill_lifecycle_events_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_skill_lifecycle_events" ADD CONSTRAINT "company_skill_lifecycle_events_version_id_company_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_lifecycle_company_skill_idx" ON "company_skill_lifecycle" USING btree ("company_id","skill_id");--> statement-breakpoint
CREATE INDEX "company_skill_lifecycle_company_state_idx" ON "company_skill_lifecycle" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "company_skill_lifecycle_events_company_skill_created_idx" ON "company_skill_lifecycle_events" USING btree ("company_id","skill_id","created_at");