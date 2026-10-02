// myrmidon(SUC): the "Stack" screen in the panel (Company section).
//
// Shows every component the board tracks: our running version, the latest
// upstream release, how far we are behind, the notable security/breaking
// lines and the patch-closed verdict. The two load buttons call the
// instance-admin routes (their failure, including 503, is surfaced in place);
// a lagging row can schedule an update, which only creates a backlog draft
// task — nothing is deployed here.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, RefreshCw, ShieldAlert } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import {
  stackApi,
  stackQueryKey,
  type StackDocument,
  type StackSnapshot,
  type StackPatchClosedState,
  type StackReleaseSource,
  type StackLocalProbe,
} from "./stackApi";
import {
  buildStackUpdatePlan,
  buildStackUpdateTitle,
  isLagging,
  isLocalUnknown,
  localVersionParts,
  sortStackComponents,
} from "./stackPresentation";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

function formatTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const PATCH_STATES: Record<StackPatchClosedState, string> = {
  closed: "stack.patches.closed",
  open: "stack.patches.open",
  unknown: "stack.patches.unknown",
};

export interface DraftInput {
  component: StackSnapshot;
  title: string;
  description: string;
}

export interface StackScreenViewProps {
  doc: StackDocument | null | undefined;
  loading: boolean;
  error: string | null;
  pendingRefresh: boolean;
  pendingCheck: boolean;
  onRefresh: () => void;
  onCheck: () => void;
  /** Creates the backlog draft task and resolves with its identifier. */
  onCreateDraft: (input: DraftInput) => Promise<string>;
}

export function StackScreenView({
  doc,
  loading,
  error,
  pendingRefresh,
  pendingCheck,
  onRefresh,
  onCheck,
  onCreateDraft,
}: StackScreenViewProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const [dialogComponent, setDialogComponent] = useState<StackSnapshot | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPlan, setDraftPlan] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createResult, setCreateResult] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const components = useMemo(() => {
    const all = doc?.components ?? [];
    const needle = filter.trim().toLowerCase();
    return sortStackComponents(needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all);
  }, [doc, filter]);

  const openDialog = (component: StackSnapshot) => {
    setDialogComponent(component);
    setDraftTitle(buildStackUpdateTitle(component));
    setDraftPlan(buildStackUpdatePlan(component));
    setCreateResult(null);
    setCreateError(null);
  };

  const submitDraft = async () => {
    if (!dialogComponent) return;
    setCreatePending(true);
    setCreateError(null);
    try {
      const identifier = await onCreateDraft({
        component: dialogComponent,
        title: draftTitle.trim(),
        description: draftPlan,
      });
      setCreateResult(identifier);
    } catch (err) {
      setCreateError(readable(err));
    } finally {
      setCreatePending(false);
    }
  };

  const refreshed = formatTime(doc?.refreshedAt ?? null);
  const checked = formatTime(doc?.checkedAt ?? null);

  return (
    <div className="max-w-5xl space-y-6" data-testid="myrmidon-stack-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("stack.title")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("stack.intro")}</p>
        <p className="text-xs text-muted-foreground">
          {t("stack.updatedAt", { time: refreshed ?? t("stack.never") })} ·{" "}
          {t("stack.checkedAt", { time: checked ?? t("stack.never") })}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pendingRefresh}
          onClick={onRefresh}
          data-testid="myrmidon-stack-refresh"
        >
          <RefreshCw className="h-4 w-4" />
          {pendingRefresh ? t("stack.refreshing") : t("stack.refresh")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pendingCheck}
          onClick={onCheck}
          data-testid="myrmidon-stack-check"
        >
          <RefreshCw className="h-4 w-4" />
          {pendingCheck ? t("stack.checking") : t("stack.check")}
        </Button>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("stack.filterPlaceholder")}
          aria-label={t("stack.filter")}
          className="max-w-xs"
          data-testid="myrmidon-stack-filter"
        />
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="myrmidon-stack-error"
        >
          {t("stack.error", { message: error })}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-stack-loading">
          {t("stack.loading")}
        </p>
      ) : components.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-stack-empty">
          {t("stack.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm" data-testid="myrmidon-stack-table">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("stack.column.name")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.source")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.ours")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.runningOn")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.latest")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.behind")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.patches")}</th>
                <th className="px-3 py-2 font-medium">{t("stack.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <StackRow
                  key={component.name}
                  component={component}
                  notesOpen={openNotes[component.name] === true}
                  onToggleNotes={() =>
                    setOpenNotes((prev) => ({ ...prev, [component.name]: !prev[component.name] }))
                  }
                  onSchedule={() => openDialog(component)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={dialogComponent !== null}
        onOpenChange={(open) => {
          if (!open) setDialogComponent(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl" data-testid="myrmidon-stack-dialog">
          {dialogComponent ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("stack.dialog.title", { name: dialogComponent.name })}</DialogTitle>
                <DialogDescription>{t("stack.dialog.intro")}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{t("stack.dialog.taskTitle")}</span>
                  <Input
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    data-testid="myrmidon-stack-dialog-title"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">{t("stack.dialog.plan")}</span>
                  <Textarea
                    value={draftPlan}
                    onChange={(event) => setDraftPlan(event.target.value)}
                    className="min-h-64 font-mono text-xs"
                    data-testid="myrmidon-stack-dialog-plan"
                  />
                </label>
                {createResult ? (
                  <p className="text-sm text-muted-foreground" data-testid="myrmidon-stack-dialog-created">
                    {t("stack.dialog.created", { identifier: createResult })}
                  </p>
                ) : null}
                {createError ? (
                  <p className="text-sm text-destructive" data-testid="myrmidon-stack-dialog-error">
                    {t("stack.dialog.failed", { message: createError })}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogComponent(null)}>
                  {t("stack.dialog.cancel")}
                </Button>
                <Button
                  disabled={createPending || draftTitle.trim().length === 0}
                  onClick={() => void submitDraft()}
                  data-testid="myrmidon-stack-dialog-create"
                >
                  {createPending ? t("stack.dialog.creating") : t("stack.dialog.create")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StackRow({
  component,
  notesOpen,
  onToggleNotes,
  onSchedule,
}: {
  component: StackSnapshot;
  notesOpen: boolean;
  onToggleNotes: () => void;
  onSchedule: () => void;
}) {
  const { t } = useTranslation();
  const upstream = component.upstreamState;
  const versions = localVersionParts(component.local);
  const unknown = isLocalUnknown(component.local);
  const patches = component.local.patches;
  const notes = upstream?.notes?.lines ?? [];
  const lagging = isLagging(component);

  return (
    <tr
      className="border-b border-border align-top last:border-0"
      data-testid={`myrmidon-stack-row-${component.name}`}
    >
      <td className="px-3 py-2">
        <div className="font-medium">{component.name}</div>
        <div className="text-xs text-muted-foreground">{t(`stack.probe.${component.localProbe}`)}</div>
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {t(`stack.source.${component.releaseSource as StackReleaseSource}`)}
      </td>
      <td className="px-3 py-2" data-testid={`myrmidon-stack-ours-${component.name}`}>
        {unknown ? (
          <span className="text-muted-foreground">
            {t("stack.unknown")}
            {component.local.unknownReason ? ` (${component.local.unknownReason})` : ""}
          </span>
        ) : (
          <span className="font-mono text-xs">{versions.join(" \u00b7 ")}</span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {component.local.runningOn ?? t("stack.unknown")}
      </td>
      <td className="px-3 py-2" data-testid={`myrmidon-stack-latest-${component.name}`}>
        {upstream?.latest ?? t("stack.unknown")}
      </td>
      <td className="px-3 py-2" data-testid={`myrmidon-stack-behind-${component.name}`}>
        {typeof upstream?.behindBy === "number"
          ? t("stack.behind", { count: upstream.behindBy })
          : t("stack.unknown")}
      </td>
      <td className="px-3 py-2" data-testid={`myrmidon-stack-patch-${component.name}`}>
        <div className="font-medium">
          {component.patchClosed
            ? t(PATCH_STATES[component.patchClosed.state])
            : t("stack.patches.none")}
        </div>
        {patches.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {patches.map((patch) => (
              <li key={patch.title}>
                {patch.title}: {t(PATCH_STATES[patch.state])}
              </li>
            ))}
          </ul>
        ) : null}
        {notes.length > 0 ? (
          <div className="mt-1">
            <button
              type="button"
              className="text-xs underline underline-offset-2 hover:text-foreground"
              onClick={onToggleNotes}
              data-testid={`myrmidon-stack-notes-${component.name}`}
            >
              {upstream?.notes?.hasSecurity ? (
                <ShieldAlert className="mr-1 inline h-3 w-3 text-destructive" />
              ) : null}
              {t("stack.notes.show")}
            </button>
            {notesOpen ? (
              <ul
                className="mt-1 space-y-0.5 text-xs text-muted-foreground"
                data-testid={`myrmidon-stack-notes-body-${component.name}`}
              >
                {notes.map((line, index) => (
                  <li key={`${component.name}-note-${index}`}>{line}</li>
                ))}
                {upstream?.notes?.truncated ? <li>{t("stack.notes.truncated")}</li> : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        {lagging ? (
          <Button size="sm" onClick={onSchedule} data-testid={`myrmidon-stack-schedule-${component.name}`}>
            {t("stack.schedule")}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export function StackScreen() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const stackQuery = useQuery({
    queryKey: stackQueryKey,
    queryFn: () => stackApi.get(),
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: () => stackApi.refresh(),
    onMutate: () => setActionError(null),
    onSuccess: (doc) => queryClient.setQueryData(stackQueryKey, doc),
    onError: (err: unknown) => setActionError(readable(err)),
  });
  const check = useMutation({
    mutationFn: () => stackApi.check(),
    onMutate: () => setActionError(null),
    onSuccess: (doc) => queryClient.setQueryData(stackQueryKey, doc),
    onError: (err: unknown) => setActionError(readable(err)),
  });

  const onCreateDraft = async ({ title, description }: DraftInput): Promise<string> => {
    if (!selectedCompanyId) throw new Error(t("stack.error", { message: "no company selected" }));
    const issue = await issuesApi.create(selectedCompanyId, {
      title,
      description,
      // A draft task: backlog and unassigned, nothing is dispatched by this screen.
      status: "backlog",
    });
    return issue.identifier ?? issue.id;
  };

  const error = actionError ?? (stackQuery.error ? readable(stackQuery.error) : null);

  return (
    <StackScreenView
      doc={stackQuery.data}
      loading={stackQuery.isLoading}
      error={error}
      pendingRefresh={refresh.isPending}
      pendingCheck={check.isPending}
      onRefresh={() => refresh.mutate()}
      onCheck={() => check.mutate()}
      onCreateDraft={onCreateDraft}
    />
  );
}