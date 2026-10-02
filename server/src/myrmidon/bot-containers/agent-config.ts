// server/src/myrmidon/bot-containers/agent-config.ts
//
// Pure helpers for reading a bot's container settings off its card. Kept separate
// from index.ts (which also wires up the real maintenance service, pulling in
// server/src/services) so these can be unit tested without loading that chain —
// the same reason server/src/myrmidon/maintenance/index.ts has no direct test file
// of its own: everything testable in it is pushed down into domain.ts/service.ts.

import type { BotContainerSpec, BotExtraMount } from "./driver.js";
import { BOT_KEY_PATTERN } from "./template.js";

export const BOT_CONTAINERS_ENV = "MYRMIDON_BOT_CONTAINERS";

export function isBotContainersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BOT_CONTAINERS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

export interface BotContainerAgentConfig {
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /** `container.extraMounts`: extra read-only directories the bot sees (a shared
   *  sources directory, templates, common tools). Their sources are checked
   *  against MYRMIDON_BOT_MOUNT_SOURCES when the container template is built. */
  extraMounts: BotExtraMount[];
}

export type BotContainerAgentConfigResult =
  | { ok: true; config: BotContainerAgentConfig }
  | { ok: false; reason: string };

/** Why `container.group` is refused for now. A container shared by a project's
 *  bots (containers-plan-senior-2026-09-28.md §1.2) needs one spec and one
 *  profile for the whole group and a maintenance window over every member agent
 *  before its gateway restarts (§2.2 p.4); reconciling it per agent, from each
 *  member's own card, would recreate and rewrite the shared container from
 *  different cards and restart it under the other members' running work. */
export const CONTAINER_GROUP_UNSUPPORTED_REASON =
  "container.group (a container shared by several agents) is not supported yet: it needs one spec, one profile and a maintenance window over every member agent, which this reconciler does not provide";

/**
 * Reads `adapterConfig.container` off an agent's card. Only `hermes_gateway`
 * agents are eligible (containers-plan-senior-2026-09-28.md's G3 scope); anything
 * else, or a missing/incomplete/`enabled !== true` block, is reported as
 * not-applicable rather than thrown — a malformed card must not take a sweep of
 * other agents down. A card asking for a shared `group` container is refused the
 * same way (see CONTAINER_GROUP_UNSUPPORTED_REASON).
 */
export function readBotContainerAgentConfig(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
): BotContainerAgentConfigResult {
  if (adapterType !== HERMES_GATEWAY_ADAPTER_TYPE) {
    return { ok: false, reason: `adapter type "${adapterType}" is not ${HERMES_GATEWAY_ADAPTER_TYPE}` };
  }
  const raw = adapterConfig?.container;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "adapterConfig.container is not set" };
  }
  const c = raw as Record<string, unknown>;
  if (c.enabled !== true) return { ok: false, reason: "adapterConfig.container.enabled is not true" };
  if (c.group !== undefined && c.group !== null) return { ok: false, reason: CONTAINER_GROUP_UNSUPPORTED_REASON };

  const { image, memoryMb, cpus, pidsLimit } = c;
  if (typeof image !== "string" || image.trim().length === 0) {
    return { ok: false, reason: "container.image must be a non-empty string" };
  }
  if (typeof memoryMb !== "number" || !Number.isFinite(memoryMb) || memoryMb <= 0) {
    return { ok: false, reason: "container.memoryMb must be a positive number" };
  }
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0) {
    return { ok: false, reason: "container.cpus must be a positive number" };
  }
  if (typeof pidsLimit !== "number" || !Number.isInteger(pidsLimit) || pidsLimit <= 0) {
    return { ok: false, reason: "container.pidsLimit must be a positive integer" };
  }
  const extraMounts = readExtraMounts(c.extraMounts);
  if (!extraMounts.ok) return { ok: false, reason: extraMounts.reason };
  return { ok: true, config: { image, memoryMb, cpus, pidsLimit, extraMounts: extraMounts.mounts } };
}

/**
 * Reads `container.extraMounts`. Structural only — a missing field means "no
 * extra mounts", an entry that is not `{source, path, readOnly?}` is refused
 * with the field named. Whether the source may be mounted at all (the
 * instance allowlist) is the driver's decision (template.ts
 * validateExtraMounts), so a card outside the allowlist is refused where the
 * container is built, with the security boundary and the card reader kept
 * apart.
 */
function readExtraMounts(
  raw: unknown,
): { ok: true; mounts: BotExtraMount[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, mounts: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "container.extraMounts must be an array" };
  const mounts: BotExtraMount[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `container.extraMounts[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `${where} must be an object` };
    }
    const mount = entry as Record<string, unknown>;
    if (typeof mount.source !== "string" || mount.source.trim().length === 0) {
      return { ok: false, reason: `${where}.source must be a non-empty string` };
    }
    if (typeof mount.path !== "string" || !mount.path.startsWith("/")) {
      return { ok: false, reason: `${where}.path must be an absolute container path` };
    }
    if (mount.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
      return { ok: false, reason: `${where}.readOnly must be a boolean` };
    }
    if (mount.readOnly === false) {
      return {
        ok: false,
        reason: `${where}.readOnly=false is not supported: a shared directory is only mounted read-only`,
      };
    }
    mounts.push({ source: mount.source, containerPath: mount.path, readOnly: true });
  }
  return { ok: true, mounts };
}

/** One container per bot, keyed by its agent id; null when the id cannot be a
 *  bot key (agent ids are lowercase uuids, which always can). */
export function botKeyForAgent(agentId: string): string | null {
  return BOT_KEY_PATTERN.test(agentId) ? agentId : null;
}

export function botContainerSpec(botKey: string, config: BotContainerAgentConfig, network: string): BotContainerSpec {
  return {
    botKey,
    image: config.image,
    memoryMb: config.memoryMb,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    network,
    extraMounts: config.extraMounts,
  };
}
