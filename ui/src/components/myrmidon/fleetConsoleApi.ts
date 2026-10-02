// Server console (SC1) API: the fleet registry and the Guacamole console token.
// Contract: docs/myrmidon/design/server-console.md.
import { api } from "@/api/client";

export type FleetConsoleProtocol = "ssh" | "vnc";

/** One node of the fleet registry, as the API returns it. */
export interface FleetServer {
  id: string;
  slug: string;
  name: string;
  hostname: string;
  port: number;
  protocol: FleetConsoleProtocol;
  username: string;
  /** Name of the panel secret that holds the node password; null means key auth. */
  passwordSecretKey: string | null;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Fields the register form sends; the server fills the protocol defaults. */
export interface FleetServerInput {
  slug: string;
  name: string;
  hostname: string;
  port?: number;
  protocol?: FleetConsoleProtocol;
  username?: string;
  passwordSecretKey?: string | null;
  description?: string | null;
  enabled?: boolean;
}

/** What the panel receives for one console click. */
export interface ConsoleToken {
  sessionId: string;
  serverId: string;
  serverSlug: string;
  serverName: string;
  protocol: string;
  token: string;
  guacamoleUrl: string;
  /** URL to open: the token travels in the `data` query parameter. */
  consoleUrl: string;
  expiresAt: string;
}

export const fleetConsoleQueryKey = (companyId: string) => ["myrmidon", "fleet-console", companyId] as const;

export const fleetConsoleApi = {
  list: (companyId: string) =>
    api.get<{ servers: FleetServer[] }>(`/myrmidon/fleet/servers?companyId=${encodeURIComponent(companyId)}`),
  register: (companyId: string, input: FleetServerInput) =>
    api.put<{ server: FleetServer }>("/myrmidon/fleet/servers", { companyId, ...input }),
  requestToken: (companyId: string, server: FleetServer) =>
    api.post<ConsoleToken>("/myrmidon/fleet/console-token", { companyId, serverId: server.id }),
  closeSession: (companyId: string, sessionId: string) =>
    api.post<{ sessionId: string; serverId: string; durationMs: number; closedAt: string }>(
      "/myrmidon/fleet/console-sessions/close",
      { companyId, sessionId },
    ),
};

/** Human-readable target of a row, for the list and the panel title. */
export function describeServerTarget(server: Pick<FleetServer, "hostname" | "port">): string {
  return `${server.hostname}:${server.port}`;
}

/** Seconds left before the token expires; used to show the panel's deadline. */
export function secondsUntil(expiresAt: string, nowMs: number): number {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return 0;
  return Math.max(0, Math.round((deadline - nowMs) / 1000));
}