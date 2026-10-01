// server/src/myrmidon/bot-containers/egress-wiring.ts
//
// myrmidon(EGRESS-B): real wiring of egress-routes.ts — the table on one side,
// the proxy's refusal feed on the other.
//
// Everything database-shaped lives here so the routes stay testable with fakes,
// and everything HTTP-shaped about the proxy lives here so the refusal feed
// stays one function. The feed is read from `MYRMIDON_BOT_EGRESS_REFUSALS_URL`
// (the proxy's address as the board reaches it) with the same shared token the
// proxy presents when it fetches the policy.

import { and, eq } from "drizzle-orm";
import { myrmidonEgressPolicies, projects, type Db } from "@paperclipai/db";
import {
  BOT_EGRESS_REFUSALS_URL_ENV,
  BOT_EGRESS_TOKEN_ENV,
  type EgressPolicyRow,
} from "./egress-policy.js";
import { botEgressRoutes, type BotEgressStore } from "./egress-routes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRow(row: {
  scope: string;
  targetId: string;
  mode: string;
  verified: boolean;
  allow: string[];
  project: string | null;
}): EgressPolicyRow {
  return {
    scope: row.scope,
    targetId: row.targetId,
    mode: row.mode,
    verified: row.verified,
    allow: row.allow,
    project: row.project,
  };
}

const SELECTED = {
  scope: myrmidonEgressPolicies.scope,
  targetId: myrmidonEgressPolicies.targetId,
  mode: myrmidonEgressPolicies.mode,
  verified: myrmidonEgressPolicies.verified,
  allow: myrmidonEgressPolicies.allow,
  project: myrmidonEgressPolicies.project,
} as const;

export function botEgressStore(db: Db): BotEgressStore {
  return {
    async list(companyId) {
      const rows = await db.select(SELECTED).from(myrmidonEgressPolicies).where(eq(myrmidonEgressPolicies.companyId, companyId));
      return rows.map(toRow);
    },
    async listAll() {
      const rows = await db.select(SELECTED).from(myrmidonEgressPolicies);
      // Project rows carry the project's id; the document the proxy reads is
      // keyed by the name the journal shows, so the name is resolved here.
      const names = await db.select({ id: projects.id, name: projects.name }).from(projects);
      const byId = new Map(names.map((row) => [row.id, row.name]));
      return rows.map((row) => {
        const mapped = toRow(row);
        return mapped.scope === "project" ? { ...mapped, project: byId.get(mapped.targetId) ?? null } : mapped;
      });
    },
    async upsertProject(companyId, projectId, policy) {
      await db
        .insert(myrmidonEgressPolicies)
        .values({
          companyId,
          scope: "project",
          targetId: projectId,
          mode: policy.mode,
          verified: policy.verified,
          allow: policy.allow,
          project: null,
        })
        .onConflictDoUpdate({
          target: [myrmidonEgressPolicies.companyId, myrmidonEgressPolicies.scope, myrmidonEgressPolicies.targetId],
          set: { mode: policy.mode, verified: policy.verified, allow: policy.allow, updatedAt: new Date() },
        });
    },
    async upsertBot(companyId, botKey, policy) {
      await db
        .insert(myrmidonEgressPolicies)
        .values({
          companyId,
          scope: "bot",
          targetId: botKey,
          mode: "log",
          verified: false,
          allow: policy.allow,
          project: policy.project || null,
        })
        .onConflictDoUpdate({
          target: [myrmidonEgressPolicies.companyId, myrmidonEgressPolicies.scope, myrmidonEgressPolicies.targetId],
          set: { allow: policy.allow, project: policy.project || null, updatedAt: new Date() },
        });
    },
    async projectNames(companyId) {
      const rows = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      return new Map(rows.map((row) => [row.id, row.name]));
    },
    async hasProject(companyId, projectId) {
      if (!UUID_PATTERN.test(projectId)) return false;
      const row = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
  };
}

/** The refusal feed of the proxy, as the board reaches it. Throws when unreachable. */
export function egressRefusalFeed(env: NodeJS.ProcessEnv = process.env): () => Promise<unknown[]> {
  return async () => {
    const base = env[BOT_EGRESS_REFUSALS_URL_ENV]?.trim();
    if (!base) throw new Error(`${BOT_EGRESS_REFUSALS_URL_ENV} is not set`);
    const token = env[BOT_EGRESS_TOKEN_ENV]?.trim();
    const url = base.endsWith("/") ? `${base}refusals` : `${base}/refusals`;
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`egress proxy answered ${response.status}`);
    const body = (await response.json()) as { refusals?: unknown };
    return Array.isArray(body.refusals) ? body.refusals : [];
  };
}

/** Router for app.ts: the egress lists and the document the proxy fetches. */
export function myrmidonBotEgressRoutes(db: Db, opts: { env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  return botEgressRoutes({
    store: botEgressStore(db),
    readRefusals: egressRefusalFeed(env),
    env,
  });
}