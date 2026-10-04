ALTER TABLE "baseline_metric_snapshots" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "baseline_metric_snapshots" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_baseline_metric_snapshots_company_pinned" ON "baseline_metric_snapshots" USING btree ("company_id","pinned") WHERE "baseline_metric_snapshots"."pinned" = true;