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

/** Do two agents' container configs describe the same container template? Compares
 *  only the fields that feed `botContainerSpec` (not `group` itself, which is what
 *  made them land in the same group in the first place). Used to detect agents that
 *  share a `container.group` (containers-plan-senior-2026-09-28.md §1.2's "shared
 *  project container") but whose cards disagree on image/resources — see
 *  `pickCanonicalGroupMember`. */
export function botContainerConfigsMatch(a: BotContainerAgentConfig, b: BotContainerAgentConfig): boolean {
  return a.image === b.image && a.memoryMb === b.memoryMb && a.cpus === b.cpus && a.pidsLimit === b.pidsLimit;
}

export interface BotContainerGroupMember<A extends { agentId: string }> {
  agent: A;
  config: BotContainerAgentConfig;
}

/**
 * Groups parsed agent configs by resolved botKey. Two or more `hermes_gateway`
 * agents can share a `container.group` and therefore the same botKey — grouping
 * them here (instead of reconciling each agent independently) is what lets a
 * sweep reconcile a shared container exactly once per tick rather than once per
 * member agent, each racing to impose its own card's spec on it.
 */
export function groupByBotKey<A extends { agentId: string }>(
  members: readonly BotContainerGroupMember<A>[],
): Map<string, BotContainerGroupMember<A>[]> {
  const groups = new Map<string, BotContainerGroupMember<A>[]>();
  for (const member of members) {
    const botKey = botKeyForAgent(member.agent.agentId, member.config);
    const group = groups.get(botKey);
    if (group) group.push(member);
    else groups.set(botKey, [member]);
  }
  return groups;
}

/**
 * Deterministically picks one member of a botKey group to reconcile: the one
 * whose `agentId` sorts first. Deterministic (not "whichever the sweep loop
 * reached last") so the same member wins every tick regardless of iteration
 * order or listAgents' own ordering — the property that stops a mismatched
 * shared-container group from oscillating between its members' specs on every
 * pass (see index.ts's sweep).
 */
export function pickCanonicalGroupMember<A extends { agentId: string }>(
  members: readonly BotContainerGroupMember<A>[],
): BotContainerGroupMember<A> {
  return members.reduce((a, b) => (a.agent.agentId <= b.agent.agentId ? a : b));
}
