-- Migration: Add label and pinned columns to baseline_metric_snapshots table

-- Add the new columns
ALTER TABLE "baseline_metric_snapshots" ADD COLUMN "label" VARCHAR;
ALTER TABLE "baseline_metric_snapshots" ADD COLUMN "pinned" BOOLEAN DEFAULT FALSE NOT NULL;

-- Create index for efficient querying by company and pinned status
CREATE INDEX "baseline_metric_snapshots_company_pinned_idx" ON "baseline_metric_snapshots" USING btree ("company_id", "pinned");

COMMIT;
