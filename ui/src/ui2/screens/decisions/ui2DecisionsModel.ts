// ui/src/ui2/screens/decisions/ui2DecisionsModel.ts
//
// myrmidon(UI2): pure helpers for the ui2 Decisions screen. They operate on
// the EXISTING vendor decision DTOs (`ui/src/api/decisions.ts`); no new
// server fields are assumed. Where the 2.0 mock carries data the API does not
// have yet (recommended flag, fact-check rows, "the swarm decided itself"
// counters), the screen hides the block — per the screen map: "a tile
// without data is hidden, it does not show zeros".

import type { Decision } from "@/api/decisions";
import type { DecisionOption } from "@paperclipai/shared";

/** The three mock filter groups, derived from ruleKey like the map suggests. */
export type Ui2DecisionGroup = "policies" | "money" | "external" | "other";

const MONEY_RULE_HINTS = ["budget", "spend", "cost", "limit", "raise", "purchase", "payment", "subscription"];
const EXTERNAL_RULE_HINTS = ["email", "post", "publish", "message", "telegram", "discord", "slack", "webhook", "register", "domain"];
const POLICY_RULE_HINTS = ["policy", "permission", "grant", "role", "rule", "guardrail", "matrix"];

export function ui2DecisionGroup(decision: Pick<Decision, "ruleKey" | "options">): Ui2DecisionGroup {
  const haystack = [decision.ruleKey ?? "", ...decision.options.map((option) => optionLabelLower(option))].join(" ");
  const matches = (hints: string[]) => hints.some((hint) => haystack.includes(hint));
  if (matches(MONEY_RULE_HINTS)) return "money";
  if (matches(EXTERNAL_RULE_HINTS)) return "external";
  if (matches(POLICY_RULE_HINTS)) return "policies";
  return "other";
}

function optionLabelLower(option: DecisionOption): string {
  return (option.label ?? "").toLowerCase();
}

/** Options sorted: primary-style first (the vendor's style hint), then label. */
export function ui2SortOptions(options: DecisionOption[]): DecisionOption[] {
  return [...options].sort((left, right) => {
    const leftPreferred = left.style === "primary" ? 0 : 1;
    const rightPreferred = right.style === "primary" ? 0 : 1;
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
    return (left.label ?? "").localeCompare(right.label ?? "");
  });
}

/**
 * Human-readable, countable effect summary per option — the "Эффект"
 * column of the mock, derived from what the vendor DTO actually carries.
 */
export function ui2OptionEffectSummary(option: DecisionOption): string {
  const labels = option.effects.map(
    (effect: DecisionOption["effects"][number]): string => {
      switch (effect.type) {
        case "comment_on_issue":
          return "comment";
        case "create_issue":
          return effect.draft.assigneeAgentId ? "create task + assign" : "create task";
        case "update_issue_status":
          return `status → ${effect.status}`;
        case "assign_issue":
          return "assign";
        case "cancel_issue_tree":
          return "cancel tree";
        case "resolve_blocker":
          return "unblock";
      }
      // Exhaustive union: unreachable, kept as a defensive fallback.
      return String((effect as { type?: string }).type ?? "effect");
    },
  );
  const deduped = [...new Set(labels)];
  return deduped.length > 0 ? deduped.join(", ") : "no effects";
}

/** Age of an open decision in a compact human form, data from `createdAt`. */
export function ui2DecisionAge(createdAt: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(createdAt).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Stable grouping key for the filter chips: group by ruleKey family, with a
 * fallback bucket that the UI labels as "All" alongside the three named.
 */
export function ui2GroupCounts(decisions: Decision[]): Record<Ui2DecisionGroup, number> {
  const counts: Record<Ui2DecisionGroup, number> = { policies: 0, money: 0, external: 0, other: 0 };
  for (const decision of decisions) counts[ui2DecisionGroup(decision)] += 1;
  return counts;
}
