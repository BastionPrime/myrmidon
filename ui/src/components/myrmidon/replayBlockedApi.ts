// N1: tasks held by an automatic "do not replay" recovery disposition.
// List: GET /api/myrmidon/companies/:companyId/replay-blocked-issues (ours, read-only).
// Resolve: the vendor POST /issues/:id/recovery-actions/resolve, or a plain status
// change when the task is closed instead of continued.
import { api, ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";

export interface ReplayBlockedIssue {
  issueId: string;
  recoveryActionId: string;
  runId: string | null;
  runAgentId: string | null;
  assigneeAgentId: string | null;
  cause: string;
  nextAction: string | null;
}

export type ReplayBlockedOutcome = "restore" | "done" | "cancel";
export type ReplayBlockedActionOutcome = "completed" | "not_performed" | "mixed";

export interface ReplayBlockedForm {
  outcome: ReplayBlockedOutcome;
  /** What happened to the stopped run's actions (restore only). */
  actionOutcome: ReplayBlockedActionOutcome;
  /** What the person checked before clearing the block. */
  checked: string;
}

/** The server requires at least this much evidence to continue a stopped execution. */
export const MIN_EVIDENCE_LENGTH = 20;

export const replayBlockedQueryKey = (companyId: string) => ["myrmidon", "replay-blocked", companyId] as const;

export const replayBlockedApi = {
  list: (companyId: string) =>
    api.get<{ issues: ReplayBlockedIssue[] }>(`/myrmidon/companies/${companyId}/replay-blocked-issues`),
};

export function formError(form: ReplayBlockedForm, item: ReplayBlockedIssue): string | null {
  const checked = form.checked.trim();
  if (form.outcome === "restore") {
    if (!item.runId) return "The stopped run is unknown, so the task cannot be continued from here. Close or cancel it instead.";
    if (checked.length < MIN_EVIDENCE_LENGTH) {
      return `Describe what you checked (at least ${MIN_EVIDENCE_LENGTH} characters).`;
    }
  } else if (checked.length === 0) {
    return "Describe what you checked.";
  }
  return null;
}

/** Request for the vendor resolve endpoint when the task continues (back to todo). */
export function restoreRequest(item: ReplayBlockedIssue, form: ReplayBlockedForm) {
  const checked = form.checked.trim();
  return {
    actionId: item.recoveryActionId,
    outcome: "restored" as const,
    sourceIssueStatus: "todo" as const,
    resolutionNote: checked,
    executionReconciliation: {
      runId: item.runId!,
      providerStopped: true as const,
      actionOutcome: form.actionOutcome,
      outcomeEvidence: checked,
    },
  };
}

export async function submitReplayBlockedResolution(item: ReplayBlockedIssue, form: ReplayBlockedForm) {
  const checked = form.checked.trim();
  if (form.outcome === "restore") {
    return issuesApi.resolveRecoveryAction(item.issueId, restoreRequest(item, form));
  }
  // Closing does not need the hold cleared: nothing wakes a done or cancelled task.
  return issuesApi.update(item.issueId, {
    status: form.outcome === "done" ? "done" : "cancelled",
    comment: `Replay block reviewed and the task ${form.outcome === "done" ? "closed as done" : "cancelled"}. Checked: ${checked}`,
  });
}

/** Human-readable reason for a failed resolution, with what to do next. */
export function describeResolveError(error: unknown, item: ReplayBlockedIssue): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError && error.status === 409) {
    if (item.runAgentId && item.assigneeAgentId !== item.runAgentId) {
      return "The task is assigned to a different agent than the one that ran the stopped run. Assign the task back to the run's agent, then clear the block again — or close or cancel the task instead.";
    }
    if (/task owner changed/i.test(message)) {
      return "The task's owner or the stopped run changed since the block was recorded. Open the run, check the current assignee (it must be the run's agent), then try again — or close or cancel the task instead.";
    }
    if (/still running/i.test(message)) {
      return "The previous provider process is still running. Stop it first, then clear the block again.";
    }
  }
  return message;
}
