import type { Request } from "express";
import type {
  AuthorizationAction,
  AuthorizationDecision,
  AuthorizationResource,
} from "../services/authorization.js";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertAgentModelsKnown } from "./agent-model-validation.js";

/**
 * myrmidon(S4): an agent never changes its own card or adapter configuration.
 *
 * Fields an agent may still change on itself. Empty by default: any
 * self-update through `agent_config:update` is denied. A caller that wants to
 * use this list passes the changed fields as `scope.selfUpdateFields`.
 */
export const AGENT_SELF_UPDATE_ALLOWED_FIELDS: readonly string[] = [];

function readSelfUpdateFields(scope: Record<string, unknown> | null | undefined): string[] | null {
  const fields = scope?.selfUpdateFields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  if (!fields.every((field) => typeof field === "string")) return null;
  return fields as string[];
}

/**
 * Returns a deny decision when an agent tries to update its own
 * configuration, or null to let the vendor rules decide. Reading the own
 * configuration is not affected.
 */
export function decideAgentSelfConfigUpdate(input: {
  action: AuthorizationAction;
  resource: AuthorizationResource;
  scope?: Record<string, unknown> | null;
  actorAgentId: string;
}): AuthorizationDecision | null {
  if (input.action !== "agent_config:update") return null;
  if (input.resource.type !== "agent" || input.resource.agentId !== input.actorAgentId) return null;
  const fields = readSelfUpdateFields(input.scope);
  if (fields && fields.every((field) => AGENT_SELF_UPDATE_ALLOWED_FIELDS.includes(field))) {
    return null;
  }
  return {
    allowed: false,
    action: input.action,
    reason: "deny_scope",
    explanation: "Agents cannot change their own configuration. Ask a board member or a managing agent.",
  };
}

function isInstanceAdminActor(req: Request): boolean {
  return (
    req.actor.type === "board" &&
    (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true)
  );
}

/**
 * myrmidon(S2/S4): `adapterConfig.inheritProcessEnv: true` hands the whole
 * server environment to the agent's runs. Only an instance admin may turn it
 * on, and every enable is logged.
 */
export function assertInheritProcessEnvChangeAllowed(
  req: Request,
  input: {
    companyId: string;
    agentId: string | null;
    previousAdapterConfig: Record<string, unknown> | null | undefined;
    nextAdapterConfig: Record<string, unknown> | null | undefined;
  },
): void {
  const wasEnabled = input.previousAdapterConfig?.inheritProcessEnv === true;
  const willEnable = input.nextAdapterConfig?.inheritProcessEnv === true;
  if (!willEnable || wasEnabled) return;
  if (!isInstanceAdminActor(req)) {
    throw forbidden("Only an instance admin can enable adapterConfig.inheritProcessEnv");
  }
  logger.warn(
    {
      companyId: input.companyId,
      agentId: input.agentId,
      actorUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    },
    "adapterConfig.inheritProcessEnv enabled: agent runs will inherit the full server environment",
  );
}

/**
 * myrmidon(S4): checks for a saved card (PATCH), called once the effective
 * adapter config is known: inheritProcessEnv is admin-only, and models must
 * come from the adapter model list.
 */
export async function assertMyrmidonAgentConfigChange(
  req: Request,
  existing: { id: string; companyId: string; adapterType: string; adapterConfig: unknown },
  nextAdapterType: string,
  nextAdapterConfig: Record<string, unknown> | null | undefined,
): Promise<void> {
  const previousAdapterConfig =
    typeof existing.adapterConfig === "object" && existing.adapterConfig !== null
      ? (existing.adapterConfig as Record<string, unknown>)
      : null;
  assertInheritProcessEnvChangeAllowed(req, {
    companyId: existing.companyId,
    agentId: existing.id,
    previousAdapterConfig,
    nextAdapterConfig,
  });
  await assertAgentModelsKnown({
    adapterType: nextAdapterType,
    previousAdapterConfig: nextAdapterType === existing.adapterType ? previousAdapterConfig : null,
    nextAdapterConfig,
  });
}
