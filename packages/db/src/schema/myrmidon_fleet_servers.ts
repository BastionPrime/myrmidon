import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * myrmidon(SC1): the fleet-server registry behind the panel's browser console.
 *
 * One row is one node the owner may open an SSH (or VNC) console to from the
 * panel. The row holds the connection target and the name of the panel secret
 * that carries the node password; the password itself is never stored here and
 * never reaches the browser. Table name is namespaced so it cannot collide with
 * a vendor table.
 */
export const myrmidonFleetServers = pgTable(
  "myrmidon_fleet_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    port: integer("port").notNull(),
    protocol: text("protocol").notNull().default("ssh"),
    username: text("username").notNull().default("fleet-console"),
    /** Panel secret key that holds the node password; null means key auth. */
    passwordSecretKey: text("password_secret_key"),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_fleet_servers_company_idx").on(table.companyId),
    companySlugUq: uniqueIndex("myrmidon_fleet_servers_company_slug_uq").on(table.companyId, table.slug),
  }),
);