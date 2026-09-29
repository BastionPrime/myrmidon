import { readPauseDrainsEnabled } from "./pause-drain.js";

/**
 * Operator-paused agents' issues are not stranded (L3b).
 *
 * With L3 (`pause-drain.ts`) an operator pause means "give no new work, let
 * the current one finish", and resuming the agent wakes its `todo` /
 * `in_progress` issues (`resumeAgentAfterPause`). The vendor's periodic
 * stranded-assigned-issue sweep (`reconcileStrandedAssignedIssues`) does not
 * know that: it checks "the agent is not invokable" before it looks for a
 * live execution path, so it blocks every issue of a paused agent and files a
 * board recovery card for it, including an issue whose run is still draining.
 * Once blocked, an issue is no longer `todo`/`in_progress`, so resume would
 * not wake it either.
 *
 * Same setting as L3: `MYRMIDON_PAUSE_DRAINS` off gives the vendor behavior.
 */

/**
 * `agents.pause_reason` written by the operator pause route: `svc.pause`
 * defaults to it and the route never passes another. Every system-initiated
 * pause writes a different value (`budget`, `system`, `company_archived`,
 * `import`, or a free-text plugin/built-in note), and a legacy row can carry
 * none at all.
 */
const OPERATOR_PAUSE_REASON = "manual";

/** True for an agent the operator paused (status `paused`, reason `manual`). */
export function isOperatorPausedAgent(
  agent: { status: string; pauseReason: string | null } | null | undefined,
): boolean {
  return agent?.status === "paused" && agent.pauseReason === OPERATOR_PAUSE_REASON;
}

/**
 * Whether the stranded-assigned-issue sweep must leave an issue alone because
 * its agent is paused by the operator. For such an agent a `todo`/
 * `in_progress` issue is either being worked on (a live, draining run) or
 * waits for the operator's resume. Both outcomes are "skip", so the decision
 * needs no run lookup: only the agent's state and the setting.
 *
 * Not exempt, so the vendor behavior stays:
 * - `MYRMIDON_PAUSE_DRAINS` off;
 * - any system pause reason (budget, archive, import, plugin note, unknown)
 *   and any other non-invokable state (terminated, pending approval, a broken
 *   reporting chain);
 * - an agent of another company or a missing agent;
 * - `in_review` issues: their participant is re-queued by the sweep itself
 *   once it is invokable again, and resume does not wake them.
 *
 * `drainsEnabled` defaults to the live setting; tests pass it explicitly.
 */
export function operatorPauseExemptsStrandedIssue(input: {
  issueStatus: string;
  issueCompanyId: string;
  agent: { companyId: string; status: string; pauseReason: string | null } | null | undefined;
  drainsEnabled?: boolean;
}): boolean {
  if (!(input.drainsEnabled ?? readPauseDrainsEnabled())) return false;
  if (input.issueStatus === "in_review") return false;
  if (!input.agent || input.agent.companyId !== input.issueCompanyId) return false;
  return isOperatorPausedAgent(input.agent);
}
