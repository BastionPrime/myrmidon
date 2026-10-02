CREATE TABLE "myrmidon_fleet_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"port" integer NOT NULL,
	"protocol" text DEFAULT 'ssh' NOT NULL,
	"username" text DEFAULT 'fleet-console' NOT NULL,
	"password_secret_key" text,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "myrmidon_fleet_servers" ADD CONSTRAINT "myrmidon_fleet_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "myrmidon_fleet_servers_company_idx" ON "myrmidon_fleet_servers" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "myrmidon_fleet_servers_company_slug_uq" ON "myrmidon_fleet_servers" USING btree ("company_id","slug");