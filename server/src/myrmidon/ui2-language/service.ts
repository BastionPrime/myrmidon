// myrmidon(UI2-I18N): per-user UI language preference for the 2.0 UI tree.
//
// The preference is an instance-wide personal setting keyed by user id (the
// same pattern as user_sidebar_preferences): it follows the person across
// companies. English is the base and the fallback; the fork ships an RU
// catalog alongside. GET reads the stored choice (default "en" when the user
// never saved one); PUT validates it, upserts the row and writes one activity
// log entry per company the user belongs to so the change shows up in the
// audit trail the way other board settings do.
//
// The service shape is dependency-injected (drizzle-free interface) so route
// contract tests run without a database; the factory here wires the drizzle
// implementation and the activity-log sink.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, userUiLanguage } from "@paperclipai/db";
import {
  ui2LanguageSchema,
  type Ui2Language,
  type Ui2LanguagePreference,
} from "@paperclipai/shared";
import { logActivity } from "../../services/index.js";

export interface Ui2LanguageAuditEntry {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export interface Ui2LanguageServiceDeps {
  getLanguage(userId: string): Promise<Ui2Language | null>;
  upsertLanguage(userId: string, language: Ui2Language): Promise<Ui2LanguagePreference>;
  listCompanyIdsForUser(userId: string): Promise<string[]>;
  logActivity(entry: Ui2LanguageAuditEntry): Promise<unknown>;
}

export const UI2_LANGUAGE_ACTION = "myrmidon.ui2.language_updated";

export function createUi2LanguageService(db: Db): Ui2LanguageServiceDeps {
  return {
    async getLanguage(userId: string): Promise<Ui2Language | null> {
      const row = await db.query.userUiLanguage.findFirst({
        where: eq(userUiLanguage.userId, userId),
      });
      if (!row) return null;
      const parsed = ui2LanguageSchema.safeParse(row.language);
      return parsed.success ? parsed.data : null;
    },

    async upsertLanguage(userId: string, language: Ui2Language): Promise<Ui2LanguagePreference> {
      const now = new Date();
      const [row] = await db
        .insert(userUiLanguage)
        .values({ userId, language, updatedAt: now })
        .onConflictDoUpdate({
          target: [userUiLanguage.userId],
          set: { language, updatedAt: now },
        })
        .returning();
      const stored = ui2LanguageSchema.parse(row?.language ?? language);
      return { language: stored, updatedAt: row?.updatedAt ?? now };
    },

    async listCompanyIdsForUser(userId: string): Promise<string[]> {
      const rows = await db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      return rows.map((row) => row.companyId);
    },

    async logActivity(entry: Ui2LanguageAuditEntry): Promise<unknown> {
      return logActivity(db, entry);
    },
  };
}

/** Resolve the audit entry list for a language change. */
export function ui2LanguageAuditEntries(
  userId: string,
  language: Ui2Language,
  previous: Ui2Language | null,
  companyIds: string[],
  actor: Omit<Ui2LanguageAuditEntry, "companyId" | "action" | "entityType" | "entityId" | "details">,
): Ui2LanguageAuditEntry[] {
  return companyIds.map((companyId) => ({
    ...actor,
    companyId,
    action: UI2_LANGUAGE_ACTION,
    entityType: "company",
    entityId: companyId,
    details: { userId, language, previous },
  }));
}
