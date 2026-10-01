// myrmidon(SC1): the fleet-server registry store (table `myrmidon_fleet_servers`).
//
// The store is an interface so the routes and the service can be exercised
// without a database; `fleetServerStore` is the only implementation that talks
// to Drizzle. Every query is scoped by company.

import { and, asc, eq } from "drizzle-orm";
import { myrmidonFleetServers, type Db } from "@paperclipai/db";
import type { FleetConsoleProtocol, FleetServerInput, FleetServerView } from "./domain.js";

export interface FleetServerStore {
  list(companyId: string): Promise<FleetServerView[]>;
  getById(companyId: string, id: string): Promise<FleetServerView | null>;
  getBySlug(companyId: string, slug: string): Promise<FleetServerView | null>;
  /** Create the row, or replace the fields of the row with the same slug. */
  upsert(companyId: string, input: FleetServerInput): Promise<FleetServerView>;
}

type FleetServerRow = typeof myrmidonFleetServers.$inferSelect;

function toView(row: FleetServerRow): FleetServerView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    protocol: row.protocol as FleetConsoleProtocol,
    username: row.username,
    passwordSecretKey: row.passwordSecretKey,
    description: row.description,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function fleetServerStore(db: Db): FleetServerStore {
  return {
    async list(companyId) {
      const rows = await db
        .select()
        .from(myrmidonFleetServers)
        .where(eq(myrmidonFleetServers.companyId, companyId))
        .orderBy(asc(myrmidonFleetServers.slug));
      return rows.map(toView);
    },

    async getById(companyId, id) {
      const row = await db
        .select()
        .from(myrmidonFleetServers)
        .where(and(eq(myrmidonFleetServers.companyId, companyId), eq(myrmidonFleetServers.id, id)))
        .then((rows) => rows[0] ?? null);
      return row ? toView(row) : null;
    },

    async getBySlug(companyId, slug) {
      const row = await db
        .select()
        .from(myrmidonFleetServers)
        .where(and(eq(myrmidonFleetServers.companyId, companyId), eq(myrmidonFleetServers.slug, slug)))
        .then((rows) => rows[0] ?? null);
      return row ? toView(row) : null;
    },

    async upsert(companyId, input) {
      const [row] = await db
        .insert(myrmidonFleetServers)
        .values({
          companyId,
          slug: input.slug,
          name: input.name,
          hostname: input.hostname,
          port: input.port,
          protocol: input.protocol,
          username: input.username,
          passwordSecretKey: input.passwordSecretKey,
          description: input.description,
          enabled: input.enabled,
        })
        .onConflictDoUpdate({
          target: [myrmidonFleetServers.companyId, myrmidonFleetServers.slug],
          set: {
            name: input.name,
            hostname: input.hostname,
            port: input.port,
            protocol: input.protocol,
            username: input.username,
            passwordSecretKey: input.passwordSecretKey,
            description: input.description,
            enabled: input.enabled,
            updatedAt: new Date(),
          },
        })
        .returning();
      return toView(row!);
    },
  };
}