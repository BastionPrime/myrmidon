// myrmidon(SC1): the console session journal.
//
// The panel's audit log is the journal of record: issuing a token writes one
// event (who, when, which node) and closing the session writes a second event
// with the duration. The close path reads the issuing event back to learn when
// the session started, so the journal is the only place the open session lives.
//
// No entry carries the token, the shared secret or the node password.

import { and, desc, eq } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import {
  CONSOLE_SESSION_CLOSED_ACTION,
  CONSOLE_SESSION_ENTITY_TYPE,
  CONSOLE_TOKEN_ISSUED_ACTION,
} from "./domain.js";

export interface ConsoleAuditActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
}

export interface ConsoleTokenIssuedEntry extends ConsoleAuditActor {
  companyId: string;
  sessionId: string;
  serverId: string;
  serverSlug: string;
  serverName: string;
  hostname: string;
  protocol: string;
  /** Node account the connection runs as. */
  nodeUsername: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface ConsoleSessionClosedEntry extends ConsoleAuditActor {
  companyId: string;
  sessionId: string;
  serverId: string;
  durationMs: number;
  closedAt: Date;
}

export interface ConsoleIssuedSession {
  issuedAt: Date;
  serverId: string | null;
  serverSlug: string | null;
}

export interface ConsoleJournal {
  recordTokenIssued(entry: ConsoleTokenIssuedEntry): Promise<void>;
  recordSessionClosed(entry: ConsoleSessionClosedEntry): Promise<void>;
  /** The issuing event of a session, or `null` when the panel has no such record. */
  findIssuedSession(companyId: string, sessionId: string): Promise<ConsoleIssuedSession | null>;
}

export function activityConsoleJournal(db: Db): ConsoleJournal {
  return {
    async recordTokenIssued(entry) {
      await logActivity(db, {
        companyId: entry.companyId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: CONSOLE_TOKEN_ISSUED_ACTION,
        entityType: CONSOLE_SESSION_ENTITY_TYPE,
        entityId: entry.sessionId,
        details: {
          serverId: entry.serverId,
          serverSlug: entry.serverSlug,
          serverName: entry.serverName,
          hostname: entry.hostname,
          protocol: entry.protocol,
          nodeUsername: entry.nodeUsername,
          sessionId: entry.sessionId,
          issuedAt: entry.issuedAt.toISOString(),
          expiresAt: entry.expiresAt.toISOString(),
        },
      });
    },

    async recordSessionClosed(entry) {
      await logActivity(db, {
        companyId: entry.companyId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: CONSOLE_SESSION_CLOSED_ACTION,
        entityType: CONSOLE_SESSION_ENTITY_TYPE,
        entityId: entry.sessionId,
        details: {
          serverId: entry.serverId,
          sessionId: entry.sessionId,
          durationMs: entry.durationMs,
          closedAt: entry.closedAt.toISOString(),
        },
      });
    },

    async findIssuedSession(companyId, sessionId) {
      const row = await db
        .select({ details: activityLog.details, createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, CONSOLE_SESSION_ENTITY_TYPE),
            eq(activityLog.entityId, sessionId),
            eq(activityLog.action, CONSOLE_TOKEN_ISSUED_ACTION),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const details = row.details ?? {};
      const issuedAt = readIsoDate(details.issuedAt) ?? row.createdAt;
      return {
        issuedAt,
        serverId: readString(details.serverId),
        serverSlug: readString(details.serverSlug),
      };
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}