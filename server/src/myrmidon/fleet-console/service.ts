// myrmidon(SC1): the console service.
//
// One place that decides whether a console token may be issued (enabled row,
// configured Guacamole client, resolvable shared secret) and that writes both
// journal events. The store, the journal and the two secret lookups are injected,
// so the rules below are testable without a database or a live Guacamole.

import { randomUUID } from "node:crypto";
import {
  buildConsoleAuthJson,
  consoleUrl,
  isOpenableServer,
  type FleetServerInput,
  type FleetServerView,
} from "./domain.js";
import type { ConsoleAuditActor, ConsoleJournal } from "./journal.js";
import type { FleetConsoleSettings } from "./settings.js";
import type { FleetServerStore } from "./store.js";
import { AUTH_JSON_SECRET_KEY_PATTERN, signGuacamoleAuthJson } from "./token.js";

export const CONSOLE_ERROR_CODES = {
  serverNotFound: "console_server_not_found",
  serverDisabled: "console_server_disabled",
  notConfigured: "console_not_configured",
  secretMissing: "console_secret_missing",
  secretInvalid: "console_secret_invalid",
  nodeSecretMissing: "console_node_secret_missing",
  sessionNotFound: "console_session_not_found",
} as const;

export class ConsoleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConsoleError";
    this.status = status;
    this.code = code;
  }
}

export interface ConsoleServiceDeps {
  store: FleetServerStore;
  journal: ConsoleJournal;
  settings: FleetConsoleSettings;
  /** The shared `json-secret-key` of the Guacamole client, from the secret store. */
  readSecretKey(companyId: string): Promise<string | null>;
  /** The node password named by a registry row, from the secret store. */
  readNodePassword(companyId: string, secretKey: string): Promise<string | null>;
  now?(): number;
  newSessionId?(): string;
}

export interface IssuedConsoleToken {
  sessionId: string;
  serverId: string;
  serverSlug: string;
  serverName: string;
  protocol: string;
  /** Signed and encrypted auth-JSON, base64. Expires after `expiresAt`. */
  token: string;
  /** Guacamole client URL, without the token. */
  guacamoleUrl: string;
  /** URL the browser opens: the same token in the `data` query parameter. */
  consoleUrl: string;
  expiresAt: string;
}

export interface ClosedConsoleSession {
  sessionId: string;
  serverId: string;
  durationMs: number;
  closedAt: string;
}

export function consoleUsernameForActor(actor: ConsoleAuditActor): string {
  return `fleet-console-${actor.actorId}`;
}

export function consoleService(deps: ConsoleServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const newSessionId = deps.newSessionId ?? (() => randomUUID());

  async function findServer(
    companyId: string,
    reference: { serverId?: string | null; slug?: string | null },
  ): Promise<FleetServerView> {
    const server = reference.serverId
      ? await deps.store.getById(companyId, reference.serverId)
      : reference.slug
        ? await deps.store.getBySlug(companyId, reference.slug)
        : null;
    if (!server) {
      throw new ConsoleError(404, CONSOLE_ERROR_CODES.serverNotFound, "Fleet server is not in the registry");
    }
    return server;
  }

  return {
    listServers(companyId: string): Promise<FleetServerView[]> {
      return deps.store.list(companyId);
    },

    upsertServer(companyId: string, input: FleetServerInput): Promise<FleetServerView> {
      return deps.store.upsert(companyId, input);
    },

    /**
     * Build the signed auth-JSON for one node and write the issuing journal
     * event. The token is valid until `expiresAt` and is not stored: only the
     * session id is.
     */
    async issueConsoleToken(input: {
      companyId: string;
      serverId?: string | null;
      slug?: string | null;
      actor: ConsoleAuditActor;
    }): Promise<IssuedConsoleToken> {
      const server = await findServer(input.companyId, input);
      if (!isOpenableServer(server)) {
        throw new ConsoleError(409, CONSOLE_ERROR_CODES.serverDisabled, "Fleet server is disabled");
      }

      const guacamoleUrl = deps.settings.guacamoleUrl;
      if (!guacamoleUrl) {
        throw new ConsoleError(
          503,
          CONSOLE_ERROR_CODES.notConfigured,
          "The instance has no console URL configured",
        );
      }

      const secretKey = await deps.readSecretKey(input.companyId);
      if (!secretKey) {
        throw new ConsoleError(
          503,
          CONSOLE_ERROR_CODES.secretMissing,
          "The panel has no console signing secret",
        );
      }
      if (!AUTH_JSON_SECRET_KEY_PATTERN.test(secretKey)) {
        throw new ConsoleError(
          503,
          CONSOLE_ERROR_CODES.secretInvalid,
          "The console signing secret is not a 128-bit hexadecimal value",
        );
      }

      let password: string | null = null;
      if (server.passwordSecretKey) {
        password = await deps.readNodePassword(input.companyId, server.passwordSecretKey);
        if (!password) {
          throw new ConsoleError(
            503,
            CONSOLE_ERROR_CODES.nodeSecretMissing,
            "The node password secret named by the registry row is missing",
          );
        }
      }

      const issuedAtMs = now();
      const expiresAtMs = issuedAtMs + deps.settings.tokenTtlMs;
      const token = signGuacamoleAuthJson(
        buildConsoleAuthJson({
          server,
          guacamoleUsername: consoleUsernameForActor(input.actor),
          password,
          expiresAt: expiresAtMs,
        }),
        secretKey,
      );

      const sessionId = newSessionId();
      await deps.journal.recordTokenIssued({
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        sessionId,
        serverId: server.id,
        serverSlug: server.slug,
        serverName: server.name,
        hostname: server.hostname,
        protocol: server.protocol,
        nodeUsername: server.username,
        issuedAt: new Date(issuedAtMs),
        expiresAt: new Date(expiresAtMs),
      });

      return {
        sessionId,
        serverId: server.id,
        serverSlug: server.slug,
        serverName: server.name,
        protocol: server.protocol,
        token,
        guacamoleUrl,
        consoleUrl: consoleUrl(guacamoleUrl, token),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    /** Close a session the panel opened, and journal how long it lasted. */
    async closeConsoleSession(input: {
      companyId: string;
      sessionId: string;
      actor: ConsoleAuditActor;
    }): Promise<ClosedConsoleSession> {
      const session = await deps.journal.findIssuedSession(input.companyId, input.sessionId);
      if (!session || !session.serverId) {
        throw new ConsoleError(
          404,
          CONSOLE_ERROR_CODES.sessionNotFound,
          "No issued console session with this id",
        );
      }
      const closedAtMs = now();
      const durationMs = Math.max(0, closedAtMs - session.issuedAt.getTime());
      await deps.journal.recordSessionClosed({
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        sessionId: input.sessionId,
        serverId: session.serverId,
        durationMs,
        closedAt: new Date(closedAtMs),
      });
      return {
        sessionId: input.sessionId,
        serverId: session.serverId,
        durationMs,
        closedAt: new Date(closedAtMs).toISOString(),
      };
    },
  };
}

export type ConsoleService = ReturnType<typeof consoleService>;