// Board self-deploy (myrmidon R5-A): the update screen of the instance
// settings. The flow is deliberately the script's flow: paste a digest →
// preview (verify it is a CI image) → deploy → the job walks
// maintenance → switch → health, with the abort available until the switch
// starts. Only instance admins can start or abort; everyone sees the state.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deployJobsApi,
  deployJobsQueryKey,
  describeDeployStatus,
  digestProblemClient,
  type DeployImagePreview,
  type DeployJobState,
  type DeployJobView,
} from "./deployJobsApi";

export function DeployJobsPanelView({
  state,
  preview,
  onPreview,
  onStart,
  onAbort,
  pending,
  error,
}: {
  state: DeployJobState | null | undefined;
  preview: DeployImagePreview | null;
  onPreview: (reference: string) => void;
  onStart: (reference: string) => void;
  onAbort: (job: DeployJobView) => void;
  pending: boolean;
  error: string | null;
}) {
  const [reference, setReference] = useState("");
  const [confirmStart, setConfirmStart] = useState(false);
  const problem = digestProblemClient(reference);
  const job = state?.job ?? null;
  const canStart = !pending && reference.trim().length > 0 && problem === null && !(job?.active ?? false);

  return (
    <section className="space-y-4" data-testid="myrmidon-deploy-jobs">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Board update</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Deploy a new image of this board from its digest. Only images built by CI from main or a myr-v* tag are
          accepted; the check cannot be skipped. The deploy pauses the board (maintenance), switches the image, checks
          health and resumes; on a failed health check the board stays paused for the rollback.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="myrmidon-deploy-error">
          {error}
        </div>
      ) : null}

      {job ? <DeployJobCard job={job} onAbort={onAbort} pending={pending} /> : <p className="text-sm text-muted-foreground">No deploy has run yet.</p>}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="myrmidon-deploy-digest">Image digest</Label>
          <Input
            id="myrmidon-deploy-digest"
            placeholder="sha256:<64 hex> or ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>"
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
              setConfirmStart(false);
            }}
          />
          {problem && reference.trim() ? <p className="text-sm text-destructive">{problem}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button size="sm" variant="outline" disabled={!canStart} onClick={() => onPreview(reference.trim())}>
            Verify image
          </Button>
          {confirmStart ? (
            <Button size="sm" variant="destructive" disabled={!canStart} onClick={() => { setConfirmStart(false); onStart(reference.trim()); }}>
              Confirm deploy
            </Button>
          ) : (
            <Button size="sm" disabled={!canStart} onClick={() => setConfirmStart(true)}>
              Deploy
            </Button>
          )}
          {confirmStart ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmStart(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
        {preview ? <PreviewCard preview={preview} /> : null}
      </div>

      {state?.history?.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Previous deploys ({state.history.length})</summary>
          <ul className="mt-2 space-y-1">
            {state.history.map((entry) => (
              <li key={entry.id} className="text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()} — {describeDeployStatus(entry.status)} — {entry.digest.slice(0, 19)}…
                {entry.failureReason ? ` — ${entry.failureReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function PreviewCard({ preview }: { preview: DeployImagePreview }) {
  return (
    <div
      className="rounded-md border border-border px-3 py-2 text-sm md:col-span-2"
      data-testid={preview.ok ? "myrmidon-deploy-preview-ok" : "myrmidon-deploy-preview-failed"}
    >
      {preview.ok ? (
        <div>
          CI image verified: commit <code>{preview.commit?.slice(0, 12)}</code>, version {preview.version ?? "<none>"}
        </div>
      ) : (
        <div className="text-destructive">Refused: {preview.reason}</div>
      )}
    </div>
  );
}

function DeployJobCard({ job, onAbort, pending }: { job: DeployJobView; onAbort: (job: DeployJobView) => void; pending: boolean }) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="myrmidon-deploy-job">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="font-medium">
            {describeDeployStatus(job.status)} — <code>{job.digest.slice(0, 19)}</code>…
            {job.version ? ` (${job.version})` : ""}
          </div>
          <div className="text-muted-foreground">
            {job.reason} · started {new Date(job.createdAt).toLocaleString()} · {job.steps.length} step(s)
          </div>
        </div>
        {job.abortable ? (
          confirmAbort ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  setConfirmAbort(false);
                  onAbort(job);
                }}
              >
                Confirm abort
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmAbort(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmAbort(true)}>
              Abort
            </Button>
          )
        ) : null}
      </div>
      {job.failureReason ? <div className="text-destructive">{job.failureReason}</div> : null}
      {job.steps.length ? (
        <ol className="space-y-1 text-muted-foreground">
          {job.steps.slice(-8).map((step, index) => (
            <li key={`${step.at}-${index}`}>
              {new Date(step.at).toLocaleTimeString()} — {describeDeployStatus(step.status)}: {step.detail}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function DeployJobsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeployImagePreview | null>(null);
  const { data } = useQuery({
    queryKey: deployJobsQueryKey,
    queryFn: () => deployJobsApi.get(),
    refetchInterval: 10_000,
    retry: false,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: deployJobsQueryKey });
  };
  const onError = (err: unknown) => {
    const message = err instanceof Error ? err.message : "Deploy request failed.";
    setError(message.includes("not enabled") ? "Deploys from the interface are not enabled on this instance." : message);
  };
  const previewMutation = useMutation({
    mutationFn: deployJobsApi.preview,
    onMutate: () => setError(null),
    onSuccess: (result) => setPreview(result),
    onError,
    onSettled: refresh,
  });
  const create = useMutation({
    mutationFn: (reference: string) => deployJobsApi.create(reference),
    onMutate: () => {
      setError(null);
      setPreview(null);
    },
    onError,
    onSettled: refresh,
  });
  const abort = useMutation({
    mutationFn: (id: string) => deployJobsApi.abort(id),
    onMutate: () => setError(null),
    onError,
    onSettled: refresh,
  });
  const pending = previewMutation.isPending || create.isPending || abort.isPending;
  return (
    <DeployJobsPanelView
      state={data}
      preview={preview}
      onPreview={(reference) => previewMutation.mutate(reference)}
      onStart={(reference) => create.mutate(reference)}
      onAbort={(job) => abort.mutate(job.id)}
      pending={pending}
      error={error}
    />
  );
}
