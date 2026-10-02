// myrmidon(U2): resolve an interaction by id across issues for chat action
// handlers that receive a provider callback in the owner's standing Telegram
// conversation (X8b) for a card that belongs to a different task. The vendor's
// own lookup is listForIssue(conversation.issueId) — strictly same-issue. This
// helper stays company-scoped and only widens the issue scope, never the
// company or actor checks around it. See docs/myrmidon/DIVERGENCE.md, U2.
import { and, eq } from "drizzle-orm";
import { issueThreadInteractions, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractionService } from "../../services/issue-thread-interactions.js";
import type { IssueThreadInteraction } from "@paperclipai/shared";

type LookupDb = Db;

/**
 * myrmidon(U2): find an interaction by id in the company, preferring the
 * vendor's same-issue projection. When the id does not belong to the given
 * issue (a card delivered to the owner's conversation from another task),
 * fall back to a direct company-scoped lookup, hydrated with its own issue's
 * terminal-status projection (same semantics listForIssue applies).
 * Returns null when nothing matches in the company.
 */
export async function listInteractionForCallback(
  db: LookupDb,
  input: {
    companyId: string;
    conversationIssueId: string;
    interactionId: string;
  },
): Promise<IssueThreadInteraction | null> {
  const sameIssue = (
    await issueThreadInteractionService(db).listForIssue(
      input.conversationIssueId,
    )
  ).find((candidate) => candidate.id === input.interactionId);
  if (sameIssue) return sameIssue;
  const [row] = await db
    .select({ interaction: issueThreadInteractions, issueStatus: issues.status })
    .from(issueThreadInteractions)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueThreadInteractions.companyId),
        eq(issues.id, issueThreadInteractions.issueId),
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.id, input.interactionId),
      ),
    )
    .then((rows) => (rows.length > 0 ? rows : []));
  const found = row ?? null;
  if (!found) return null;
  // Reuse the vendor hydration path so terminal-issue pending cards surface as
  // expired exactly like listForIssue would for their own issue.
  return (
    await issueThreadInteractionService(db).listForIssue(
      found.interaction.issueId,
    )
  ).find((candidate) => candidate.id === input.interactionId) ?? null;
}
