// Run limits (C0, RUNTIME-LIMITS): the ceilings on runs this server starts,
// editable while it runs. Saving applies them at once — queued runs start
// within a minute, no restart and no run in flight is dropped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { RunLimits, RunLimitsPatch, RunLimitKey } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  describeRunLimitSource,
  runtimeLimitsApi,
  runtimeLimitsQueryKey,
  type RuntimeLimitsView,
} from "./runtimeLimitsApi";

const FIELDS: Array<{ key: RunLimitKey; label: string; hint: string; optional: boolean }> = [
  {
    key: "maxConcurrentRuns",
    label: "Concurrent runs",
    hint: "Runs this server starts at once. Runs over the ceiling stay queued and start when a slot frees.",
    optional: true,
  },
  {
    key: "maxStartsPerMinute",
    label: "Starts per minute",
    hint: "How many runs may start in a sliding minute, so a restart or a bulk resolve does not start everything in one burst.",
    optional: true,
  },
  {
    key: "minFreeMemoryMb",
    label: "Free memory to keep, MB",
    hint: "A run starts only if the server container keeps this much memory free after it.",
    optional: true,
  },
  {
    key: "runMemoryEstimateMb",
    label: "Memory per run, MB",
    hint: "What one run is budgeted when free memory is counted.",
    optional: false,
  },
];

interface DraftParse {
  patch: RunLimitsPatch | null;
  errors: Partial<Record<RunLimitKey, string>>;
}

/** An empty field means "no limit"; anything else must be a positive integer. */
export function parseRunLimitsDraft(draft: Record<RunLimitKey, string>): DraftParse {
  const errors: Partial<Record<RunLimitKey, string>> = {};
  const parsed = {} as Record<RunLimitKey, number | null>;
  for (const { key, optional } of FIELDS) {
    const raw = draft[key].trim();
    const value = raw ? Number(raw) : null;
    if (raw && (value === null || !Number.isInteger(value) || value <= 0)) {
      errors[key] = "Enter a whole number greater than zero, or leave it empty";
      continue;
    }
    if (value === null && !optional) {
      errors[key] = "Required";
      continue;
    }
    parsed[key] = value;
  }
  if (Object.keys(errors).length > 0) return { patch: null, errors };
  // The per-run budget is required, so it is a number by now; the check keeps
  // the type honest without a cast.
  const estimate = parsed.runMemoryEstimateMb;
  if (estimate === null) return { patch: null, errors: { runMemoryEstimateMb: "Required" } };
  return {
    patch: {
      maxConcurrentRuns: parsed.maxConcurrentRuns,
      maxStartsPerMinute: parsed.maxStartsPerMinute,
      minFreeMemoryMb: parsed.minFreeMemoryMb,
      runMemoryEstimateMb: estimate,
    },
    errors,
  };
}

function toDraft(limits: RunLimits): Record<RunLimitKey, string> {
  return {
    maxConcurrentRuns: limits.maxConcurrentRuns === null ? "" : String(limits.maxConcurrentRuns),
    maxStartsPerMinute: limits.maxStartsPerMinute === null ? "" : String(limits.maxStartsPerMinute),
    minFreeMemoryMb: limits.minFreeMemoryMb === null ? "" : String(limits.minFreeMemoryMb),
    runMemoryEstimateMb: String(limits.runMemoryEstimateMb),
  };
}

export function RuntimeLimitsSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: RuntimeLimitsView | null | undefined;
  onSave: (patch: RunLimitsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<Record<RunLimitKey, string> | null>(null);
  const current = draft ?? (view ? toDraft(view.limits) : null);
  const { patch, errors } = current
    ? parseRunLimitsDraft(current)
    : { patch: null, errors: {} as Partial<Record<RunLimitKey, string>> };

  return (
    <section className="space-y-4" data-testid="myrmidon-runtime-limits">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Run limits</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          How many agent runs this server starts at once, how fast, and how much memory it keeps free. A run over a
          ceiling waits in the queue and starts when a slot frees. Saving takes effect immediately: queued runs start
          within a minute and no running run is interrupted. Leave a field empty to switch that limit off.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          {FIELDS.map(({ key, label, hint, optional }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`runtime-limit-${key}`}>{label}</Label>
              <Input
                id={`runtime-limit-${key}`}
                inputMode="numeric"
                placeholder={optional ? "No limit" : "Required"}
                value={current ? current[key] : ""}
                onChange={(event) =>
                  setDraft({ ...(current ?? toDraft(view.limits)), [key]: event.target.value })
                }
              />
              <div className="text-xs text-muted-foreground">
                <span data-testid={`runtime-limit-source-${key}`}>
                  {describeRunLimitSource(view.sources[key])}
                </span>
                {errors[key] ? (
                  <span data-testid={`runtime-limit-error-${key}`} className="ml-2 text-destructive">
                    {errors[key]}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
          ))}
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? "Saving..." : "Save run limits"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading run limits...</p>
      )}
    </section>
  );
}

export function RuntimeLimitsSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: runtimeLimitsQueryKey,
    queryFn: () => runtimeLimitsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: runtimeLimitsApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the run limits failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: runtimeLimitsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load run limits."}
      </div>
    );
  }

  return (
    <RuntimeLimitsSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}