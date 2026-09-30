CREATE TABLE "myrmidon_egress_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" text NOT NULL,
	"mode" text DEFAULT 'log' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"allow" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "myrmidon_egress_policies" ADD CONSTRAINT "myrmidon_egress_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_egress_policies_company_scope_target_uq" ON "myrmidon_egress_policies" USING btree ("company_id","scope","target_id");--> statement-breakpoint
CREATE INDEX "myrmidon_egress_policies_company_scope_idx" ON "myrmidon_egress_policies" USING btree ("company_id","scope");