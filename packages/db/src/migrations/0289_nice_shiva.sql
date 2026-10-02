-- myrmidon(UI2-I18N): per-user board UI language preference for the 2.0 UI
-- tree. Additive only: one new table + a unique index on user_id; no vendor
-- table is touched, no data is rewritten (generated with drizzle-kit).
CREATE TABLE "user_ui_language" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_ui_language_user_uq" ON "user_ui_language" USING btree ("user_id");