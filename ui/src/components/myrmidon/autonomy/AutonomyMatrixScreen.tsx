// myrmidon(1.6 AUTONOMY-MATRIX B): the "Autonomy matrix" settings screen.
//
// What each role may do on its own and what needs a human: a role ×
// action-class matrix (cell cycles allowed / approval_required / forbidden),
// per-role regulations with Draft → Approved and revision history, and the
// change log. The matrix PATCH and the regulation CRUD go through Part A's
// landed API (packages/shared/src/myrmidon-autonomy.ts,
// server/src/myrmidon/autonomy): types import from @paperclipai/shared. Per
// the epic design note §3.4, the reminders/night-mode/answer-
// channel fields are read-only placeholders in 1.6 — they need the reminder
// scheduler, a later follow-up.
//
// Screen split: this file is layout + local interaction state; the wire
// state (queries, mutations, error surfaces) lives in
// AutonomyMatrixContainer.tsx so tests can drive both tiers separately.
import { useState } from "react";
import { History, ShieldCheck } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUTONOMY_ACTION_CLASSES,
  AUTONOMY_VERDICTS,
  resolveAutonomy,
  type AutonomyActionClass,
  type AutonomyMatrix,
  type AutonomyRegulation,
  type AutonomyVerdict,
  type AutonomySnapshot as AutonomyView,
} from "@paperclipai/shared";
import { AGENT_ROLES, AGENT_ROLE_LABELS } from "@paperclipai/shared";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Semantic color for a verdict label. */
function verdictClass(verdict: AutonomyVerdict): string {
  switch (verdict) {
    case "allowed":
      return "text-foreground";
    case "approval_required":
      return "text-muted-foreground";
    case "forbidden":
      return "text-destructive";
  }
}

/** A role label, robust to a role stored in the matrix that the catalog lacks. */
export function roleLabel(role: string): string {
  return AGENT_ROLE_LABELS[role as keyof typeof AGENT_ROLE_LABELS] ?? role;
}

export interface RegulationDraft {
  role: string;
  title: string;
  bodyMarkdown: string;
}

export const EMPTY_REGULATION_DRAFT: RegulationDraft = {
  role: "engineer",
  title: "",
  bodyMarkdown: "",
};

export function AutonomyMatrixScreenView({
  view,
  matrix,
  matrixDirty,
  onCellClick,
  onDefaultChange,
  onSaveMatrix,
  savingMatrix,
  matrixError,
  regulationError,
  pendingRegulationId,
  onCreateRegulation,
  onUpdateRegulation,
  onApproveRegulation,
  onRestoreRevision,
}: {
  view: AutonomyView;
  /** The working copy — starts as the loaded matrix, diverges on edits. */
  matrix: AutonomyMatrix;
  matrixDirty: boolean;
  onCellClick: (role: string, actionClass: AutonomyActionClass) => void;
  onDefaultChange: (actionClass: AutonomyActionClass, verdict: AutonomyVerdict) => void;
  onSaveMatrix: () => void;
  savingMatrix: boolean;
  matrixError: string | null;
  regulationError: string | null;
  pendingRegulationId: string | null;
  onCreateRegulation: (draft: RegulationDraft) => void;
  onUpdateRegulation: (id: string, draft: { title: string; bodyMarkdown: string }) => void;
  onApproveRegulation: (id: string) => void;
  onRestoreRevision: (id: string, revision: number) => void;
}) {
  const { t } = useTranslation();
  const [newRegulation, setNewRegulation] = useState<RegulationDraft>(EMPTY_REGULATION_DRAFT);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, { title: string; bodyMarkdown: string }>>({});

  const draftFor = (regulation: AutonomyRegulation): { title: string; bodyMarkdown: string } =>
    draftEdits[regulation.id] ?? { title: regulation.title, bodyMarkdown: regulation.bodyMarkdown };

  return (
    <div className="max-w-5xl space-y-6" data-testid="myrmidon-autonomy-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("autonomy.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("autonomy.intro")}</p>
      </div>

      {/* Matrix editor: rows are roles, columns are action classes. */}
      <section className="space-y-2" data-testid="myrmidon-autonomy-matrix">
        <h2 className="text-sm font-semibold">{t("autonomy.matrix.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("autonomy.matrix.hint")}</p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="myrmidon-autonomy-matrix-table">
            <thead>
              <tr>
                <th className="text-left text-xs font-medium text-muted-foreground">
                  {t("autonomy.matrix.role")}
                </th>
                {AUTONOMY_ACTION_CLASSES.map((actionClass) => (
                  <th
                    key={actionClass}
                    className="px-2 text-xs font-medium text-muted-foreground"
                    data-testid={`myrmidon-autonomy-col-${actionClass}`}
                  >
                    {t(`autonomy.actionClass.${actionClass}`)}
                    <span
                      className="block font-normal"
                      data-testid={`myrmidon-autonomy-default-${actionClass}`}
                    >
                      {t("autonomy.matrix.default")}: {t(`autonomy.verdict.${matrix.defaults[actionClass]}`)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AGENT_ROLES.map((role) => (
                <tr key={role} data-testid={`myrmidon-autonomy-row-${role}`}>
                  <th scope="row" className="text-left text-sm font-medium">
                    {roleLabel(role)}
                  </th>
                  {AUTONOMY_ACTION_CLASSES.map((actionClass) => {
                    const effective = resolveAutonomy(role, actionClass, matrix);
                    // A pinned cell carries its own rule; an inherited cell
                    // follows the action-class default (marked with *).
                    const explicit = matrix.rules.some(
                      (r) => r.role === role && r.actionClass === actionClass && r.agentId === undefined,
                    );
                    return (
                      <td key={actionClass} className="px-2 py-1">
                        <button
                          type="button"
                          className={`rounded-md border border-border px-2 py-1 text-xs font-medium ${verdictClass(effective)}`}
                          data-testid={`myrmidon-autonomy-cell-${role}-${actionClass}`}
                          aria-label={`${roleLabel(role)} ${actionClass}: ${t(`autonomy.verdict.${effective}`)}`}
                          title={t("autonomy.matrix.cycleHint")}
                          onClick={() => onCellClick(role, actionClass)}
                        >
                          {t(`autonomy.verdict.${effective}`)}
                          {explicit ? null : <span className="text-muted-foreground"> *</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Default verdict per action class (a cell without a rule → default). */}
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("autonomy.matrix.defaults")}
          </h3>
          <div className="grid gap-2 md:grid-cols-2">
            {AUTONOMY_ACTION_CLASSES.map((actionClass) => (
              <div key={actionClass} className="flex items-center gap-2" data-testid={`myrmidon-autonomy-default-select-${actionClass}`}>
                <Label htmlFor={`autonomy-default-${actionClass}`} className="w-48 shrink-0 text-xs">
                  {t(`autonomy.actionClass.${actionClass}`)}
                </Label>
                <Select
                  value={matrix.defaults[actionClass]}
                  onValueChange={(value) => onDefaultChange(actionClass, value as AutonomyVerdict)}
                >
                  <SelectTrigger id={`autonomy-default-${actionClass}`} size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTONOMY_VERDICTS.map((verdict) => (
                      <SelectItem key={verdict} value={verdict}>
                        {t(`autonomy.verdict.${verdict}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>

        {matrixError ? (
          <p className="text-sm text-destructive" data-testid="myrmidon-autonomy-matrix-error">
            {matrixError}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!matrixDirty || savingMatrix}
            onClick={onSaveMatrix}
            data-testid="myrmidon-autonomy-matrix-save"
          >
            {savingMatrix ? t("autonomy.matrix.saving") : t("autonomy.matrix.save")}
          </Button>
          {matrixDirty ? (
            <span className="text-xs text-muted-foreground" data-testid="myrmidon-autonomy-matrix-dirty">
              {t("autonomy.matrix.unsaved")}
            </span>
          ) : null}
        </div>
      </section>

      {/* Regulations: per role, Draft → Approved, revisions, rollback. */}
      <section className="space-y-2" data-testid="myrmidon-autonomy-regulations">
        <h2 className="text-sm font-semibold">{t("autonomy.regulations.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("autonomy.regulations.hint")}</p>

        {view.regulations.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-autonomy-regulations-empty">
            {t("autonomy.regulations.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {view.regulations.map((regulation) => {
              const open = expandedId === regulation.id;
              const edit = draftFor(regulation);
              const editDirty =
                edit.title !== regulation.title || edit.bodyMarkdown !== regulation.bodyMarkdown;
              const pending = pendingRegulationId === regulation.id;
              return (
                <li
                  key={regulation.id}
                  className="space-y-2 rounded-md border border-border px-3 py-2"
                  data-testid={`myrmidon-autonomy-regulation-${regulation.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      className="text-left text-sm font-medium"
                      onClick={() => setExpandedId(open ? null : regulation.id)}
                      data-testid={`myrmidon-autonomy-regulation-toggle-${regulation.id}`}
                    >
                      {regulation.title}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {roleLabel(regulation.role)} ·{" "}
                        {t(`autonomy.regulationStatus.${regulation.status}`)} ·{" "}
                        {t("autonomy.regulations.revision", { count: regulation.revision })}
                      </span>
                    </button>
                    <div className="flex items-center gap-2">
                      {regulation.status === "draft" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => onApproveRegulation(regulation.id)}
                          data-testid={`myrmidon-autonomy-regulation-approve-${regulation.id}`}
                        >
                          {t("autonomy.regulations.approve")}
                        </Button>
                      ) : null}
                      {regulation.revision > 1 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => onRestoreRevision(regulation.id, regulation.revision - 1)}
                          data-testid={`myrmidon-autonomy-regulation-restore-${regulation.id}`}
                        >
                          <History className="mr-1 h-3 w-3" />
                          {t("autonomy.regulations.restore", { count: regulation.revision - 1 })}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {open ? (
                    regulation.status === "draft" ? (
                      <div className="space-y-2">
                        <div>
                          <Label htmlFor={`autonomy-regulation-title-${regulation.id}`} className="text-xs">
                            {t("autonomy.regulations.titleLabel")}
                          </Label>
                          <Input
                            id={`autonomy-regulation-title-${regulation.id}`}
                            value={edit.title}
                            onChange={(event) =>
                              setDraftEdits((prev) => ({
                                ...prev,
                                [regulation.id]: { ...edit, title: event.target.value },
                              }))
                            }
                            data-testid={`myrmidon-autonomy-regulation-title-${regulation.id}`}
                          />
                        </div>
                        <div>
                          <Label htmlFor={`autonomy-regulation-body-${regulation.id}`} className="text-xs">
                            {t("autonomy.regulations.bodyLabel")}
                          </Label>
                          <Textarea
                            id={`autonomy-regulation-body-${regulation.id}`}
                            value={edit.bodyMarkdown}
                            onChange={(event) =>
                              setDraftEdits((prev) => ({
                                ...prev,
                                [regulation.id]: { ...edit, bodyMarkdown: event.target.value },
                              }))
                            }
                            data-testid={`myrmidon-autonomy-regulation-body-${regulation.id}`}
                          />
                        </div>
                        <Button
                          size="sm"
                          disabled={!editDirty || pending}
                          onClick={() => onUpdateRegulation(regulation.id, edit)}
                          data-testid={`myrmidon-autonomy-regulation-save-${regulation.id}`}
                        >
                          {t("autonomy.regulations.saveDraft")}
                        </Button>
                      </div>
                    ) : (
                      <pre
                        className="whitespace-pre-wrap text-xs text-muted-foreground"
                        data-testid={`myrmidon-autonomy-regulation-body-${regulation.id}`}
                      >
                        {regulation.bodyMarkdown}
                      </pre>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {regulationError ? (
          <p className="text-sm text-destructive" data-testid="myrmidon-autonomy-regulation-error">
            {regulationError}
          </p>
        ) : null}

        {/* New regulation form */}
        <div
          className="space-y-2 rounded-md border border-border px-3 py-3"
          data-testid="myrmidon-autonomy-regulation-new"
        >
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("autonomy.regulations.newTitle")}
          </h3>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="autonomy-new-role" className="text-xs">
                {t("autonomy.regulations.roleLabel")}
              </Label>
              <Select
                value={newRegulation.role}
                onValueChange={(role) => setNewRegulation((prev) => ({ ...prev, role }))}
              >
                <SelectTrigger id="autonomy-new-role" size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabel(role)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="autonomy-new-title" className="text-xs">
                {t("autonomy.regulations.titleLabel")}
              </Label>
              <Input
                id="autonomy-new-title"
                value={newRegulation.title}
                onChange={(event) => setNewRegulation((prev) => ({ ...prev, title: event.target.value }))}
                data-testid="myrmidon-autonomy-regulation-new-title"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="autonomy-new-body" className="text-xs">
              {t("autonomy.regulations.bodyLabel")}
            </Label>
            <Textarea
              id="autonomy-new-body"
              value={newRegulation.bodyMarkdown}
              onChange={(event) => setNewRegulation((prev) => ({ ...prev, bodyMarkdown: event.target.value }))}
              data-testid="myrmidon-autonomy-regulation-new-body"
            />
          </div>
          <Button
            size="sm"
            disabled={newRegulation.title.trim().length === 0}
            onClick={() => {
              onCreateRegulation(newRegulation);
              setNewRegulation({ ...newRegulation, title: "", bodyMarkdown: "" });
            }}
            data-testid="myrmidon-autonomy-regulation-create"
          >
            {t("autonomy.regulations.create")}
          </Button>
        </div>
      </section>

      {/* Change log */}
      <section className="space-y-2" data-testid="myrmidon-autonomy-changelog">
        <h2 className="text-sm font-semibold">{t("autonomy.changeLog.title")}</h2>
        {view.changeLog.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-autonomy-changelog-empty">
            {t("autonomy.changeLog.empty")}
          </p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="myrmidon-autonomy-changelog-list">
            {view.changeLog.map((entry) => (
              <li key={entry.id} data-testid="myrmidon-autonomy-changelog-entry">
                {formatTime(entry.at)} · {entry.actor.type} ·{" "}
                {t(`autonomy.changeAction.${entry.action}`, { defaultValue: entry.action })} · {entry.summary}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Read-only placeholders per the epic design note §3.4 (1.6 scope-down):
          reminders/night-mode/answer-channel need the reminder scheduler and
          follow-up work; they are shown, never editable, this release. */}
      <section className="space-y-1" data-testid="myrmidon-autonomy-placeholders">
        <h2 className="text-sm font-semibold">{t("autonomy.placeholders.title")}</h2>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-autonomy-placeholder-reminders">
          {t("autonomy.placeholders.reminders")}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-autonomy-placeholder-nightMode">
          {t("autonomy.placeholders.nightMode")}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-autonomy-placeholder-answerChannel">
          {t("autonomy.placeholders.answerChannel")}
        </p>
      </section>
    </div>
  );
}