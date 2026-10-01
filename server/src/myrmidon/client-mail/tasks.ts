// server/src/myrmidon/client-mail/tasks.ts
//
// myrmidon(EXTCASE-M): the board task the mail path creates for the client's
// platform bot.
//
// The board task is the hand-off of the case: the mail pipeline recognizes the
// tender documentation and the *platform* bot takes it from there (opens the
// tender platform in the client's browser and works the bid). So the task is
// assigned to the agent the client company named in its mail settings, and it
// lives in that company — a client's mail never creates work in another
// company's board.
//
// Idempotency is carried by the caller's key (`client-mail:<company>:<messageId>`),
// which the issue service replays: a message delivered twice creates one task.
//
// The adapter is thin on purpose: everything interesting happens in the issue
// service, which already owns the numbering, the notifications and the wake of
// the assignee. This file only maps a draft onto its input shape and refuses to
// guess a company or an agent that was not configured.

import type { Db } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import type { ClientMailTaskCreator, ClientMailTaskDraft } from "./pipeline.js";

export interface ClientMailTaskCreatorOptions {
  /** Overridden in tests; the server passes the real issue service factory. */
  createIssue?: (
    db: Db,
    companyId: string,
    input: {
      title: string;
      description: string;
      status: string;
      priority: string;
      assigneeAgentId: string;
      idempotencyKey: string;
    },
  ) => Promise<{ id: string; identifier: string | null }>;
}

/**
 * The real creator. The task is created `todo` and `high`: the batch wants a
 * person-free lane, and the tender deadline is what the case exists for.
 */
export function createClientMailTaskCreator(db: Db, options: ClientMailTaskCreatorOptions = {}): ClientMailTaskCreator {
  const createIssue =
    options.createIssue ??
    (async (handle, companyId, input) => {
      const created = await issueService(handle).create(companyId, {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
        idempotencyKey: input.idempotencyKey,
      });
      return { id: created.id, identifier: created.identifier ?? null };
    });

  return {
    async createTask(draft: ClientMailTaskDraft) {
      if (!draft.companyId) throw new Error("the mail task has no company");
      if (!draft.assigneeAgentId) throw new Error("the mail task has no assignee agent");
      return createIssue(db, draft.companyId, {
        title: draft.title,
        description: draft.description,
        status: "todo",
        priority: "high",
        assigneeAgentId: draft.assigneeAgentId,
        idempotencyKey: draft.idempotencyKey,
      });
    },
  };
}