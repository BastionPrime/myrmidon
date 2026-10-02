/**
 * Configurable cross-issue influence cap (P5).
 *
 * The cap is the per-run budget of writes to tasks other than the task the run
 * came from (comments, updates, interaction resolutions). Vendor code hard-codes
 * 20. A run that lays out a dozen subtasks from a parent task spends the budget
 * before the layout is finished, and the rest of the writes are refused.
 *
 * The budget stays 20 unless the operator raises it through the environment.
 * The value is read on every evaluation, so a change applies to the next
 * mutation without a restart.
 *
 * Blank, non-numeric, zero, negative and unsafe values fall back to the default:
 * the cap is a backstop against a runaway cross-task write loop, so "unset" or
 * "mangled" must never mean "unlimited".
 */

export const CROSS_ISSUE_INFLUENCE_LIMIT_ENV = "MYRMIDON_CROSS_ISSUE_INFLUENCE_LIMIT";
export const DEFAULT_CROSS_ISSUE_INFLUENCE_LIMIT = 20;

/** Returns the configured cap; invalid values fall back to the default. */
export function readCrossIssueInfluenceLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CROSS_ISSUE_INFLUENCE_LIMIT_ENV]?.trim();
  if (!raw) return DEFAULT_CROSS_ISSUE_INFLUENCE_LIMIT;
  if (!/^\d+$/.test(raw)) return DEFAULT_CROSS_ISSUE_INFLUENCE_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_CROSS_ISSUE_INFLUENCE_LIMIT;
  return value;
}