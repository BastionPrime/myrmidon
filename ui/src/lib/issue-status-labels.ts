// myrmidon(UI-RU): localized task status labels shared by the task list,
// inbox, and kanban surfaces. Falls back to the vendor English wording when
// no translation is active.
import type { TFunction } from "i18next";
import type { IssueStatus } from "@paperclipai/shared";

const STATUS_KEYS: Record<IssueStatus, string> = {
  backlog: "status.backlog",
  todo: "status.todo",
  in_progress: "status.in_progress",
  in_review: "status.in_review",
  done: "status.done",
  blocked: "status.blocked",
  cancelled: "status.cancelled",
};

export function localizedIssueStatusLabel(status: IssueStatus, t: TFunction): string {
  return t(STATUS_KEYS[status]);
}

export function buildIssueStatusLabels(t: TFunction): Record<IssueStatus, string> {
  return {
    backlog: localizedIssueStatusLabel("backlog", t),
    todo: localizedIssueStatusLabel("todo", t),
    in_progress: localizedIssueStatusLabel("in_progress", t),
    in_review: localizedIssueStatusLabel("in_review", t),
    done: localizedIssueStatusLabel("done", t),
    blocked: localizedIssueStatusLabel("blocked", t),
    cancelled: localizedIssueStatusLabel("cancelled", t),
  };
}
