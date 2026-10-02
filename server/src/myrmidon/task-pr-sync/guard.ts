// Task PR sync guard.
//
// The wake path asks this module whether a run for a task would be pointless
// because the task is already delivered: every one of its pull_request work
// products has reached a terminal state (merged or closed) with at least one
// merged, but the task has not been settled to `done` yet. While that is true the
// sweep is about to close the task, so waking the assignee for it only produces a
// run that races the settle.
//
// The signature is fixed by the cross-part contract:
//   shouldSuppressRunForIssue(issueId: string, db: Db) => Promise<boolean>
// It reads stored rows only — no GitHub call — so it is cheap enough for the wake
// path. `false` is the safe default: a task with no PR work product, or one that
// is already terminal, is never suppressed.

import { eq } from "drizzle-orm";
import { issueWorkProducts, issues, type Db } from "@paperclipai/db";
import { settlePendingForProducts } from "./policy.js";

export async function shouldSuppressRunForIssue(issueId: string, db: Db): Promise<boolean> {
  const issue = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue) return false;
  if (issue.status === "done" || issue.status === "cancelled") return false;

  const products = await db
    .select({ type: issueWorkProducts.type, status: issueWorkProducts.status })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, issueId));

  return settlePendingForProducts(products);
}