import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

// myrmidon(UI2-I18N): per-user board UI language preference for the 2.0 UI
// tree. Instance-wide personal preference keyed by user id (same pattern as
// user_sidebar_preferences): the language choice follows the person across
// companies, so no company scoping. The fork rule "state in existing JSON
// fields" does not fit a per-user setting that must survive on its own row
// (announcement dismissals use a dedicated table for the same reason).
export const userUiLanguage = pgTable(
  "user_ui_language",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    language: text("language").notNull().default("en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_ui_language_user_uq").on(table.userId),
  }),
);
