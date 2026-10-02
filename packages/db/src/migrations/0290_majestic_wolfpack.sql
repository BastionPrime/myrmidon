CREATE TABLE "myrmidon_eval_reference_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"rubric" jsonb NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "myrmidon_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"subject" text NOT NULL,
	"baseline_id" uuid,
	"confirm_run_id" uuid,
	"kind" text DEFAULT 'first' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"scores" jsonb,
	"verdict" text,
	"verdict_reason" text,
	"threshold_drop" integer,
	"confirmed" boolean DEFAULT false NOT NULL,
	"model" text,
	"ci_pass_rate" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "myrmidon_eval_reference_tasks" ADD CONSTRAINT "myrmidon_eval_reference_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "myrmidon_eval_runs" ADD CONSTRAINT "myrmidon_eval_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "myrmidon_eval_reference_tasks_company_idx" ON "myrmidon_eval_reference_tasks" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_eval_reference_tasks_company_role_slug_uq" ON "myrmidon_eval_reference_tasks" USING btree ("company_id","role","slug");--> statement-breakpoint
CREATE INDEX "myrmidon_eval_runs_company_idx" ON "myrmidon_eval_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "myrmidon_eval_runs_company_role_started_idx" ON "myrmidon_eval_runs" USING btree ("company_id","role","started_at");--> statement-breakpoint
CREATE INDEX "myrmidon_eval_runs_baseline_idx" ON "myrmidon_eval_runs" USING btree ("baseline_id");