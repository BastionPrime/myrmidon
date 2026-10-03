// server/src/myrmidon/wip-limit/signal.ts
//
// myrmidon(1.6.1-WIP-LIMIT-A): the system-notice comment of an over-limit agent.
//
// One comment per agent per window (UTC day), written into the agent's most
// recent in_progress task. The dedup key `wip-limit:<agentId>:<utc day>` rides
// in the comment metadata's first section row — the same seam the budget
// signal uses, so the check is a single indexed read, not a scan.
//
// The write is best-effort: a failed signal is logged and swallowed, because
// the sweep that calls it must never break on a comment race.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import {
  wipLimitSignalKey,
  type WipLimitAgentStatus,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
} from "@paperclipai/shared";

/** The signal window: one UTC day. */
export const WIP_LIMIT_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ports so tests can stub the comment service boundary. */
export interface WipLimitSignalPorts {
  addComment(
    issueId: string,
    body: string,
    actor: Record<string, never>,
    options: {
      authorType: "system";
      presentation: IssueCommentPresentation;
      metadata: IssueCommentMetadata;
    },
  ): Promise<unknown>;
  now(): Date;
}

function buildBody(status: WipLimitAgentStatus, agentName: string | null): string {
  const label = agentName ?? "This agent";
  if (status.leadRule) {
    return [
      `${label} has direct reports, so its role is supervision and acceptance; implementation work on a lead is over the WIP limit by definition.`,
      "",
      `- Tasks in flight: ${status.wip} (${status.inProgress} in progress, ${status.inReview} in review)`,
      "",
      "To resolve: hand the implementation task to an engineer and keep this task for review and acceptance.",
    ].join("\n");
  }
  return [
    `${label} is over its WIP limit.`,
    "",
    `- Tasks in flight: ${status.wip} (${status.inProgress} in progress, ${status.inReview} in review)`,
    `- Limit: ${status.limit ?? 0}`,
    "",
    "To resolve: finish or hand off tasks until the count is within the limit (the signal repeats at most once a day while the state holds).",
  ].join("\n");
}

function buildPresentation(): IssueCommentPresentation {
  return {
    kind: "system_notice",
    tone: "warning",
    title: "WIP limit exceeded",
    detailsDefaultOpen: true,
  };
}

function buildMetadata(
  status: WipLimitAgentStatus,
  windowStart: Date,
  issueId: string,
): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "WIP limit signal",
        rows: [
          {
            type: "key_value",
            label: "Signal key",
            value: wipLimitSignalKey(status.agentId, windowStart),
          },
          { type: "key_value", label: "Agent", value: status.agentId },
          { type: "key_value", label: "Tasks in flight", value: String(status.wip) },
          { type: "key_value", label: "In progress", value: String(status.inProgress) },
          { type: "key_value", label: "In review", value: String(status.inReview) },
          { type: "key_value", label: "Limit", value: status.limit === null ? "none" : String(status.limit) },
          { type: "key_value", label: "Lead rule", value: status.leadRule ? "yes" : "no" },
          { type: "key_value", label: "Issue", value: issueId },
        ],
      },
    ],
  };
}

/** The agent's most recent in_progress task (visible rows only). */
export async function latestInProgressIssue(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ id: string; identifier: string | null } | null> {
  const rows = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        eq(issues.status, "in_progress"),
        sql`${issues.hiddenAt} is null`,
      ),
    )
    .orderBy(desc(issues.updatedAt), desc(issues.id))
    .limit(1);
  return rows[0] ?? null;
}

/** True when the agent already has this window's signal comment anywhere. */
export async function hasWipLimitSignalComment(
  db: Db,
  companyId: string,
  agentId: string,
  windowStart: Date,
): Promise<boolean> {
  const key = wipLimitSignalKey(agentId, windowStart);
  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.metadata} -> 'sections' -> 0 -> 'rows' -> 0 ->> 'value' = ${key}`,
      ),
    )
    .limit(1);
  return Boolean(existing[0]);
}

/**
 * Deliver the signal for one over-limit agent: one comment on its latest
 * in_progress task. Never throws — the sweep logs and moves on.
 */
export async function deliverWipLimitSignal(
  db: Db,
  ports: WipLimitSignalPorts,
  input: {
    companyId: string;
    status: WipLimitAgentStatus;
    agentName: string | null;
  },
): Promise<{ written: boolean; issueId: string | null }> {
  const now = ports.now();
  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  try {
    if (await hasWipLimitSignalComment(db, input.companyId, input.status.agentId, windowStart)) {
      return { written: false, issueId: null };
    }
    const issue = await latestInProgressIssue(db, input.companyId, input.status.agentId);
    if (!issue) return { written: false, issueId: null };
    await ports.addComment(
      issue.id,
      buildBody(input.status, input.agentName),
      {} as Record<string, never>,
      {
        authorType: "system",
        presentation: buildPresentation(),
        metadata: buildMetadata(input.status, windowStart, issue.id),
      },
    );
    return { written: true, issueId: issue.id };
  } catch {
    return { written: false, issueId: null };
  }
}
