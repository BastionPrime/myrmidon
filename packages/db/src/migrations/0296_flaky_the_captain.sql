CREATE TABLE "guardrail_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"surface" text NOT NULL,
	"severity" text NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"snippet" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardrail_events_company_occurred_idx" ON "guardrail_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "guardrail_events_run_id_idx" ON "guardrail_events" USING btree ("run_id");