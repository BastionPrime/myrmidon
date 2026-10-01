// server/src/myrmidon/client-mail/rules.ts
//
// myrmidon(EXTCASE-M): the client's own rules, applied before any model.
//
// The client's rules are the first classifier: a message that a rule matches is
// decided by that rule and never reaches a model, so the client's own sorting is
// reproduced exactly, costs nothing, and keeps working when the gateway is down.
// The model only sees what no rule claimed.
//
// Both functions are pure and come from the shared contract: the panel previews
// a rule with `mailRuleMatches`, the pipeline decides with it. One
// implementation, so a preview cannot disagree with what the bot later does.

import {
  decisionFromRule,
  mailRuleMatches,
  orderedMailRules,
  type ClientMailItem,
  type ClientMailRule,
  type ClientMailDecision,
} from "@paperclipai/shared";

/**
 * The decision of the first matching enabled rule, or null when no rule
 * matched. `ruleTrace` names every rule that was tried and did not match, for
 * the journal: an operator who wonders why a rule did not fire can see which
 * rules ran, without a message body ever being written down.
 */
export function classifyByRules(
  rules: ClientMailRule[],
  item: ClientMailItem,
): { decision: ClientMailDecision | null; ruleTrace: string[] } {
  const ordered = orderedMailRules(rules);
  const ruleTrace: string[] = [];
  for (const rule of ordered) {
    if (mailRuleMatches(rule, item)) {
      return { decision: decisionFromRule(rule), ruleTrace };
    }
    ruleTrace.push(rule.name);
  }
  return { decision: null, ruleTrace };
}