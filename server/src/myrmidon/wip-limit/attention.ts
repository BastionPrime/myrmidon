// server/src/myrmidon/wip-limit/attention.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the attention-feed cards of the WIP limit.
//
// One card per over-limit agent, built from the same live status the API
// reports. The feed recomputes on every list, so nothing is persisted here —
// the card exists exactly while the agent is over its limit, and disappears
// the moment it is not (the exit rule the operators see is the same fact).
//
// The lead rule produces the same card with its own wording: a lead holding
// implementation work is over the limit by definition (limit 0), and the card
// says so instead of quoting a number that is not the real cause.

import type { AttentionSeverity } from "@paperclipai/shared";
import type { WipLimitAgentStatus } from "@paperclipai/shared";

/** One attention card the feed renders for an over-limit agent. */
export interface WipLimitAttentionCard {
  agentId: string;
  agentName: string | null;
  dedupKey: string;
  title: string;
  whyNow: string;
  severity: AttentionSeverity;
  summaryExcerpt: string;
  leadRule: boolean;
  metadata: Record<string, unknown>;
}

export const WIP_LIMIT_ATTENTION_DEDUP_PREFIX = "wip_limit";

function buildWhyNow(status: WipLimitAgentStatus): string {
  if (status.leadRule) {
    return "This agent has direct reports and is a lead; a lead doing implementation work (a task in progress or review) is over the limit by definition — the implementation limit of a lead is 0.";
  }
  const limit = status.limit ?? 0;
  return `This agent holds ${status.wip} tasks in flight (${status.inProgress} in progress, ${status.inReview} in review), over its WIP limit of ${limit}.`;
}

function buildTitle(status: WipLimitAgentStatus, agentName: string | null): string {
  const label = agentName ?? "An agent";
  if (status.leadRule) {
    return `${label} is a lead holding implementation work`;
  }
  return `${label} is over its WIP limit`;
}

/**
 * Build the cards for every over-limit status row. `agentNameById` supplies
 * the display names (the caller reads them once with the agents query).
 */
export function buildWipLimitAttentionCards(
  statuses: readonly WipLimitAgentStatus[],
  agentNameById: ReadonlyMap<string, string>,
): WipLimitAttentionCard[] {
  return statuses
    .filter((status) => status.overLimit)
    .map((status) => {
      const agentName = agentNameById.get(status.agentId) ?? null;
      const whyNow = buildWhyNow(status);
      return {
        agentId: status.agentId,
        agentName,
        dedupKey: `${WIP_LIMIT_ATTENTION_DEDUP_PREFIX}:${status.agentId}`,
        title: buildTitle(status, agentName),
        whyNow,
        severity: (status.leadRule ? "medium" : "low") as AttentionSeverity,
        summaryExcerpt: whyNow,
        leadRule: status.leadRule,
        metadata: {
          originAgentId: status.agentId,
          wip: status.wip,
          inProgress: status.inProgress,
          inReview: status.inReview,
          limit: status.limit,
          leadRule: status.leadRule,
        },
      };
    });
}
