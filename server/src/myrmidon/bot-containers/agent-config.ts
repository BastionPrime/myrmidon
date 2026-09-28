// server/src/myrmidon/bot-containers/agent-config.ts
//
// Pure helpers for reading a bot's container settings off its card. Kept separate
// from index.ts (which also wires up the real maintenance service, pulling in
// server/src/services) so these can be unit tested without loading that chain —
// the same reason server/src/myrmidon/maintenance/index.ts has no direct test file
// of its own: everything testable in it is pushed down into domain.ts/service.ts.

import type { BotContainerSpec } from "./driver.js";
import { BOT_KEY_PATTERN } from "./template.js";

export const BOT_CONTAINERS_ENV = "MYRMIDON_BOT_CONTAINERS";

export function isBotContainersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BOT_CONTAINERS_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

export interface BotContainerAgentConfig {
  /** Container this bot shares with the rest of its project; unset = its own
   *  container, keyed by agent id (containers-plan-senior-2026-09-28.md §1.2). */
  group?: string;
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export type BotContainerAgentConfigResult =
  | { ok: true; config: BotContainerAgentConfig }
  | { ok: false; reason: string };

/**
 * Reads `adapterConfig.container` off an agent's card. Only `hermes_gateway`
 * agents are eligible (containers-plan-senior-2026-09-28.md's G3 scope); anything
 * else, or a missing/incomplete/`enabled !== true` block, is reported as
 * not-applicable rather than thrown — a malformed card must not take a sweep of
 * other agents down.
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

  const { image, memoryMb, cpus, pidsLimit, group } = c;
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
  let groupValue: string | undefined;
  if (group !== undefined) {
    if (typeof group !== "string" || !BOT_KEY_PATTERN.test(group)) {
      return { ok: false, reason: "container.group must match the bot key pattern (lowercase letters, digits, hyphens)" };
    }
    groupValue = group;
  }
  return { ok: true, config: { group: groupValue, image, memoryMb, cpus, pidsLimit } };
}

/** A container-per-bot by default; `container.group` opts an agent into a shared
 *  project container instead. */
export function botKeyForAgent(agentId: string, config: BotContainerAgentConfig): string {
  return config.group ?? agentId;
}

export function botContainerSpec(botKey: string, config: BotContainerAgentConfig, network: string): BotContainerSpec {
  return {
    botKey,
    image: config.image,
    memoryMb: config.memoryMb,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    network,
  };
}
