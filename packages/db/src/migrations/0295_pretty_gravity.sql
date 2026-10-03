-- myrmidon(1.6-SWARM): the lease table of the per-role task queues. Additive
-- only: one new table plus its four indexes and four foreign keys; no vendor
-- table is touched, no data is rewritten (generated with drizzle-kit).
CREATE TABLE "issue_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"role" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
ALTER TABLE "issue_claims" ADD CONSTRAINT "issue_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_claims" ADD CONSTRAINT "issue_claims_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_claims" ADD CONSTRAINT "issue_claims_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_claims" ADD CONSTRAINT "issue_claims_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_claims_issue_live_idx" ON "issue_claims" USING btree ("issue_id","released_at");--> statement-breakpoint
CREATE INDEX "issue_claims_company_agent_live_idx" ON "issue_claims" USING btree ("company_id","agent_id","released_at");--> statement-breakpoint
CREATE INDEX "issue_claims_expires_idx" ON "issue_claims" USING btree ("expires_at","released_at");--> statement-breakpoint
CREATE INDEX "issue_claims_company_claimed_idx" ON "issue_claims" USING btree ("company_id","claimed_at");