// myrmidon(SC1): the fleet-server registry record and the auth-JSON built from it.
//
// A registry row names the connection target and the panel secret that holds
// the node password. The password is resolved on the server and travels inside
// the signed and encrypted auth-JSON only: the browser never sees it, because
// the browser only ever holds the ciphertext.

import type { GuacamoleAuthJson } from "./token.js";

export const FLEET_CONSOLE_PROTOCOLS = ["ssh", "vnc"] as const;
export type FleetConsoleProtocol = (typeof FLEET_CONSOLE_PROTOCOLS)[number];

/** Node account the console connects as when a row does not name its own. */
export const FLEET_CONSOLE_DEFAULT_USERNAME = "fleet-console";

/** Row shape as the API returns it (timestamps as ISO strings). */
export interface FleetServerView {
  id: string;
  slug: string;
  name: string;
  hostname: string;
  port: number;
  protocol: FleetConsoleProtocol;
  username: string;
  /** Panel secret key that holds the node password; `null` means key auth. */
  passwordSecretKey: string | null;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Values accepted when a row is created or replaced. */
export interface FleetServerInput {
  slug: string;
  name: string;
  hostname: string;
  port: number;
  protocol: FleetConsoleProtocol;
  username: string;
  passwordSecretKey: string | null;
  description: string | null;
  enabled: boolean;
}

export const FLEET_SERVER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Audit actions the console writes; the journal keys on these. */
export const CONSOLE_TOKEN_ISSUED_ACTION = "myrmidon.console.token_issued";
export const CONSOLE_SESSION_CLOSED_ACTION = "myrmidon.console.session_closed";
export const CONSOLE_SESSION_ENTITY_TYPE = "myrmidon_console_session";

export const CONSOLE_DEFAULT_PROTOCOL_PORT: Record<FleetConsoleProtocol, number> = {
  ssh: 22,
  vnc: 5900,
};

/**
 * Connection parameters of one Guacamole connection. `hostname`/`port` always
 * travel; the credential is added only when the panel resolved one, so a
 * key-based node does not carry an empty password into guacd.
 */
export function buildConnectionParameters(
  server: Pick<FleetServerView, "protocol" | "hostname" | "port" | "username">,
  password: string | null,
): Record<string, string> {
  const parameters: Record<string, string> = {
    hostname: server.hostname,
    port: String(server.port),
  };
  if (server.protocol === "ssh") {
    parameters.username = server.username;
  } else if (server.username) {
    parameters.username = server.username;
  }
  if (password) {
    parameters.password = password;
  }
  return parameters;
}

/** The auth-JSON document Guacamole receives, signed and encrypted. */
export function buildConsoleAuthJson(input: {
  server: Pick<FleetServerView, "name" | "protocol" | "hostname" | "port" | "username">;
  /** Guacamole username; the panel's own identity of the operator. */
  guacamoleUsername: string;
  password: string | null;
  expiresAt: number;
}): GuacamoleAuthJson {
  return {
    username: input.guacamoleUsername,
    expires: input.expiresAt,
    connections: {
      [input.server.name]: {
        protocol: input.server.protocol,
        parameters: buildConnectionParameters(input.server, input.password),
      },
    },
  };
}

/**
 * URL the browser opens: the Guacamole client reads the base64 blob from the
 * `data` query parameter and exchanges it for a session token of its own.
 */
export function consoleUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/#/?data=${encodeURIComponent(token)}`;
}

/** Row-level decision: only an enabled row may be opened. */
export function isOpenableServer(server: Pick<FleetServerView, "enabled">): boolean {
  return server.enabled === true;
}