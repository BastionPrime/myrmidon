// N1: make the automatic "do not replay" hold visible and clearable by people.
// A task in this state is never woken again; the vendor UI only shows a quiet
// notice on the task page. The board UI is for people; the server additionally
// refuses agents (list: board only; resolve: board only for this path).
import { useContext, useState } from "react";
import { QueryClientContext, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  describeResolveError,
  formError,
  replayBlockedApi,
  replayBlockedQueryKey,
  submitReplayBlockedResolution,
  type ReplayBlockedActionOutcome,
  type ReplayBlockedForm,
  type ReplayBlockedIssue,
  type ReplayBlockedOutcome,
} from "./replayBlockedApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const ALERT_CLASS =
  "border border-red-300/70 bg-red-50 text-red-950 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100";

const OUTCOME_LABELS: Record<ReplayBlockedOutcome, string> = {
  restore: "Continue the task (back to todo)",
  done: "Close as done",
  cancel: "Cancel the task",
};

const ACTION_OUTCOME_LABELS: Record<ReplayBlockedActionOutcome, string> = {
  completed: "The run's actions were completed",
  not_performed: "The run's actions were not performed",
  mixed: "Some actions were completed, some not",
};

/** One shared request per company: every row and the task page read the same list. */
export function useReplayBlockedIssues(companyId: string | null | undefined) {
  return useQuery({
    queryKey: replayBlockedQueryKey(companyId ?? ""),
    queryFn: () => replayBlockedApi.list(companyId!),
    enabled: !!companyId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

export function useReplayBlockedIssue(companyId: string | null | undefined, issueId: string) {
  const { data } = useReplayBlockedIssues(companyId);
  return data?.issues.find((item) => item.issueId === issueId) ?? null;
}

export function ReplayBlockedChipView({ item }: { item: ReplayBlockedIssue | null }) {
  if (!item) return null;
  return (
    <span
      data-testid="myrmidon-replay-blocked-chip"
      title={`Replay blocked: ${item.nextAction ?? item.cause}. Open the task to review and clear it.`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${ALERT_CLASS}`}
    >
      <OctagonX className="h-3 w-3" />
      Replay blocked
    </span>
  );
}

function ReplayBlockedChipQuery({ companyId, issueId }: { companyId: string | null | undefined; issueId: string }) {
  return <ReplayBlockedChipView item={useReplayBlockedIssue(companyId, issueId)} />;
}

/** Chip for task list rows. Renders nothing where rows are shown without a query client. */
export function ReplayBlockedChip(props: { companyId: string | null | undefined; issueId: string }) {
  return useContext(QueryClientContext) ? <ReplayBlockedChipQuery {...props} /> : null;
}

export function ReplayBlockedNoticeView({
  item,
  pending,
  error,
  onSubmit,
}: {
  item: ReplayBlockedIssue;
  pending: boolean;
  error: string | null;
  onSubmit: (form: ReplayBlockedForm) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ReplayBlockedForm>({ outcome: "restore", actionOutcome: "not_performed", checked: "" });
  const invalid = formError(form, item);
  return (
    <div role="alert" data-testid="myrmidon-replay-blocked-notice" className={`my-2 rounded-md px-3 py-2 text-sm ${ALERT_CLASS}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 font-semibold">
            <OctagonX className="h-4 w-4 shrink-0" />
            Replay blocked — this task will not be woken again
          </div>
          <p>
            {item.nextAction ?? "Automatic recovery stopped."} Cause: <code>{item.cause}</code>.
            {item.runId && item.runAgentId ? (
              <>
                {" "}
                <Link to={`/agents/${item.runAgentId}/runs/${item.runId}`} className="underline">
                  Open the stopped run
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Review and clear
          </Button>
        )}
      </div>
      {open && (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid && !pending) onSubmit(form);
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="myrmidon-replay-outcome">Outcome</Label>
            <select
              id="myrmidon-replay-outcome"
              className={SELECT_CLASS}
              value={form.outcome}
              onChange={(event) => setForm({ ...form, outcome: event.target.value as ReplayBlockedOutcome })}
            >
              {(Object.keys(OUTCOME_LABELS) as ReplayBlockedOutcome[]).map((value) => (
                <option key={value} value={value}>
                  {OUTCOME_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          {form.outcome === "restore" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="myrmidon-replay-action-outcome">What happened to the stopped run's actions</Label>
              <select
                id="myrmidon-replay-action-outcome"
                className={SELECT_CLASS}
                value={form.actionOutcome}
                onChange={(event) =>
                  setForm({ ...form, actionOutcome: event.target.value as ReplayBlockedActionOutcome })
                }
              >
                {(Object.keys(ACTION_OUTCOME_LABELS) as ReplayBlockedActionOutcome[]).map((value) => (
                  <option key={value} value={value}>
                    {ACTION_OUTCOME_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="myrmidon-replay-checked">What was checked</Label>
            <Textarea
              id="myrmidon-replay-checked"
              value={form.checked}
              placeholder="For example: the provider process is stopped; the commit from the run is not in the branch."
              onChange={(event) => setForm({ ...form, checked: event.target.value })}
            />
          </div>
          {invalid && form.checked.length > 0 && <p className="text-xs">{invalid}</p>}
          {error && (
            <p data-testid="myrmidon-replay-blocked-error" className="font-medium">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!!invalid || pending}>
              {pending ? "Clearing…" : "Clear the block"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Notice for the task page. */
export function ReplayBlockedNotice({
  companyId,
  issueId,
  onResolved,
}: {
  companyId: string;
  issueId: string;
  onResolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const item = useReplayBlockedIssue(companyId, issueId);
  const mutation = useMutation({
    mutationFn: (form: ReplayBlockedForm) => submitReplayBlockedResolution(item!, form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: replayBlockedQueryKey(companyId) });
      onResolved?.();
    },
  });
  if (!item) return null;
  return (
    <ReplayBlockedNoticeView
      item={item}
      pending={mutation.isPending}
      error={mutation.isError ? describeResolveError(mutation.error, item) : null}
      onSubmit={(form) => mutation.mutate(form)}
    />
  );
}
