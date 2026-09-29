// myrmidon(W2b): bot container status and "Apply now" for the agent card.
// GET/POST /api/myrmidon/agents/:id/bot-container/{status,apply}
// (server/src/myrmidon/bot-containers/routes.ts).
import { api, ApiError } from "@/api/client";

export type BotContainerState = "running" | "stopped" | "missing" | "unhealthy";

export interface BotContainerStatus {
  /** The instance switch for bot containers is on. */
  enabled: boolean;
  /** The instance has a container runtime wired. */
  runtimeConfigured: boolean;
  /** The SAVED card is an enabled, complete container config. */
  eligible: boolean;
  /** Why the saved card is not eligible. */
  reason: string | null;
  /** Image patterns this instance allows; empty means no image is allowed. */
  imageAllowlist: string[];
  /** Whether the saved image matches the allowlist; null without a saved image. */
  imageAllowed: boolean | null;
  container: { state: BotContainerState; image: string | null } | null;
  containerError: string | null;
}

export type BotContainerApplyOutcome =
  | { kind: "created" }
  | { kind: "applied_files" }
  | { kind: "applied_restart" }
  | { kind: "unchanged" }
  | { kind: "deferred"; reason: string }
  | { kind: "error"; message: string };

export const botContainerStatusKey = (agentId: string) => ["myrmidon", "bot-container", agentId, "status"] as const;

const base = (agentId: string) => `/myrmidon/agents/${encodeURIComponent(agentId)}/bot-container`;

export const botContainerApi = {
  status: (agentId: string) => api.get<BotContainerStatus>(`${base(agentId)}/status`),
  apply: (agentId: string) => api.post<{ outcome: BotContainerApplyOutcome }>(`${base(agentId)}/apply`, {}),
};

export type ApplyFeedback = { kind: "ok" | "warn" | "error"; message: string };

export function describeApplyOutcome(outcome: BotContainerApplyOutcome): ApplyFeedback {
  switch (outcome.kind) {
    case "created":
      return { kind: "ok", message: "Container created and started." };
    case "applied_files":
      return { kind: "ok", message: "Profile files updated in the running container." };
    case "applied_restart":
      return { kind: "ok", message: "Profile updated and the gateway restarted." };
    case "unchanged":
      return { kind: "ok", message: "Nothing to change: the container already matches the card." };
    case "deferred":
      return { kind: "warn", message: `Not applied yet: ${outcome.reason}` };
    default:
      return { kind: "error", message: `Apply failed: ${outcome.message}` };
  }
}

/** The request failed before or instead of an outcome. The server's own message is
 *  kept for the cases where it says something the person can act on. */
export function describeApplyError(error: unknown): ApplyFeedback {
  if (error instanceof ApiError) {
    const code = typeof (error.body as { code?: unknown } | null)?.code === "string"
      ? (error.body as { code: string }).code
      : null;
    if (code === "bot_containers_disabled") {
      return { kind: "error", message: "Bot containers are not enabled on this instance." };
    }
    if (code === "bot_container_runtime_unavailable") {
      return { kind: "error", message: "The bot container runtime is not configured on this instance." };
    }
    if (error.status === 502) return { kind: "error", message: `Apply failed: ${error.message}` };
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: error instanceof Error ? error.message : "Apply failed." };
}
