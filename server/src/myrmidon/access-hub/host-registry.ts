// myrmidon(SEC1): fleet host registry — the `myrmidonAccessHubHosts` key of
// instance_settings.general.
//
// The vendor settings service normalizes `general` through strip() and drops
// unknown keys (see the maintenance module for the same problem), so this
// module reads and writes the raw row itself, exactly like maintenance/store.ts.
// The vendor updateGeneral must carry our key over; that hook is the one-line
// change in server/src/services/instance-settings.ts, registered in
// DIVERGENCE.md track 5.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import type { AccessHubHost } from "./types.js";

export const ACCESS_HUB_HOSTS_GENERAL_KEY = "myrmidonAccessHubHosts";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

export const MAX_HOSTS = 200;
const MAX_NAME_CHARS = 120;
const MAX_ADDRESS_CHARS = 253;
const MAX_USER_CHARS = 64;

/** Parse the stored JSON array into hosts; anything malformed is ignored
 * (an empty registry), never a 500. */
export function parseAccessHubHosts(raw: unknown): AccessHubHost[] {
  if (!Array.isArray(raw)) return [];
  const hosts: AccessHubHost[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    if (typeof record.address !== "string" || typeof record.targetUser !== "string") continue;
    if (typeof record.enabled !== "boolean") continue;
    hosts.push({
      id: record.id,
      name: record.name,
      address: record.address,
      targetUser: record.targetUser,
      enabled: record.enabled,
    });
  }
  return hosts.slice(0, MAX_HOSTS);
}

/** Address check: hostname, IPv4 or IPv6 literal. Neutral examples only in
 * tests (example.com, 192.0.2.0/24); the check itself is generic. */
const HOST_ADDRESS_PATTERN =
  /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\[[0-9a-fA-F:]+\]$|^[0-9a-fA-F:]{2,45}$/;

export function isValidHostAddress(address: string): boolean {
  return HOST_ADDRESS_PATTERN.test(address);
}

export function validateAccessHubHost(input: {
  name: string;
  address: string;
  targetUser: string;
}): string | null {
  if (!input.name.trim() || input.name.length > MAX_NAME_CHARS) return "name";
  if (!input.address.trim() || input.address.length > MAX_ADDRESS_CHARS) return "address";
  if (!isValidHostAddress(input.address.trim())) return "address";
  if (!input.targetUser.trim() || input.targetUser.length > MAX_USER_CHARS) return "targetUser";
  return null;
}

export async function readAccessHubHosts(db: Runner): Promise<AccessHubHost[]> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseAccessHubHosts(row?.general?.[ACCESS_HUB_HOSTS_GENERAL_KEY]);
}

/** The change callback of the host registry writer: returns the next array
 * (null = leave as is) plus a result value handed back to the caller. */
export type AccessHubHostsChange<T> = (current: AccessHubHost[]) => { next: AccessHubHost[] | null; result: T };

/** Read-modify-write the hosts array under a row lock, so two concurrent API
 * calls cannot lose each other's write. The default implementation is
 * mutateAccessHubHosts; route tests inject a fake with the same shape. */
export type AccessHubHostsWriter = <T>(change: AccessHubHostsChange<T>) => Promise<{
  hosts: AccessHubHost[];
  result: T;
  changed: boolean;
}>;

/** Read-modify-write the hosts array under a row lock. */
export function mutateAccessHubHosts<T>(
  db: Db,
  change: AccessHubHostsChange<T>,
): Promise<{ hosts: AccessHubHost[]; result: T; changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = parseAccessHubHosts(row.general?.[ACCESS_HUB_HOSTS_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { hosts: current, result, changed: false };
    const capped = next.slice(0, MAX_HOSTS);
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${ACCESS_HUB_HOSTS_GENERAL_KEY}}`}::text[], ${JSON.stringify(capped)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { hosts: capped, result, changed: true };
  });
}

export function newAccessHubHostId(): string {
  return randomUUID();
}

/** Carry our key over a vendor write of instance_settings.general (the same
 * shape as preserveMaintenanceGeneralKey). */
export function preserveAccessHubHostsGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[ACCESS_HUB_HOSTS_GENERAL_KEY];
  return value === undefined ? {} : { [ACCESS_HUB_HOSTS_GENERAL_KEY]: value };
}
