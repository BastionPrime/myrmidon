// Maintenance mode (R3) controls for instance admins: enter a window for a scope,
// see open windows, end them. The server enforces instance-admin access.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  maintenanceApi,
  maintenanceQueryKey,
  type MaintenanceEnterInput,
  type MaintenanceOnTimeout,
  type MaintenanceScope,
  type MaintenanceScopeType,
  type MaintenanceStatus,
} from "./maintenanceApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

const SCOPE_LABELS: Record<MaintenanceScopeType, string> = {
  instance: "Instance",
  company: "Company",
  department: "Department (manager and reports)",
  agent: "Agent",
};

export function scopeTitle(scope: MaintenanceScope): string {
  return scope.type === "instance" ? "Instance" : `${SCOPE_LABELS[scope.type]} ${scope.id ?? ""}`.trim();
}

export function MaintenanceSettingsPanelView({
  status,
  onEnter,
  onExit,
  pending,
  error,
}: {
  status: MaintenanceStatus | null | undefined;
  onEnter: (input: MaintenanceEnterInput) => void;
  onExit: (scope: MaintenanceScope) => void;
  pending: boolean;
  error: string | null;
}) {
  const [scopeType, setScopeType] = useState<MaintenanceScopeType>("instance");
  const [scopeId, setScopeId] = useState("");
  const [reason, setReason] = useState("");
  const [drainTimeoutSec, setDrainTimeoutSec] = useState("900");
  const [onTimeout, setOnTimeout] = useState<MaintenanceOnTimeout>("wait");
  const [confirmExit, setConfirmExit] = useState<string | null>(null);

  const needsId = scopeType !== "instance";
  const timeout = Number(drainTimeoutSec);
  const canEnter =
    !pending && reason.trim().length > 0 && (!needsId || scopeId.trim().length > 0) && Number.isInteger(timeout) && timeout >= 0;

  return (
    <section className="space-y-4" data-testid="myrmidon-maintenance-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Maintenance</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          While a window is open, new agent runs in its scope do not start, wakes queue up, routines and watchdogs pause.
          Running runs finish; after the drain timeout they keep running or are interrupted and retried after the window
          ends.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}

      {status?.windows.length ? (
        <ul className="space-y-2">
          {status.windows.map((window) => (
            <li key={window.id} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="font-medium">
                  {scopeTitle(window.scope)} — {window.state}
                  {window.drainTimedOut ? " (drain timed out)" : ""}
                </div>
                <div className="text-muted-foreground">
                  {window.reason} · running {window.runningRuns} · queued runs {window.queuedRuns} · queued wakes{" "}
                  {window.queuedWakeups} · interrupted {window.interruptedRuns}
                </div>
              </div>
              {confirmExit === window.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => {
                      setConfirmExit(null);
                      onExit(window.scope);
                    }}
                  >
                    Confirm end
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmExit(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" disabled={pending || window.state === "leaving"} onClick={() => setConfirmExit(window.id)}>
                  End maintenance
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No maintenance window is open.</p>
      )}

      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEnter) return;
          onEnter({
            scope: needsId ? { type: scopeType, id: scopeId.trim() } : { type: "instance" },
            reason: reason.trim(),
            drainTimeoutSec: timeout,
            onTimeout,
          });
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="myrmidon-maintenance-scope">Scope</Label>
          <select
            id="myrmidon-maintenance-scope"
            className={SELECT_CLASS}
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value as MaintenanceScopeType)}
          >
            {Object.entries(SCOPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {needsId ? (
          <div className="space-y-1">
            <Label htmlFor="myrmidon-maintenance-scope-id">{scopeType === "company" ? "Company id" : "Agent id"}</Label>
            <Input id="myrmidon-maintenance-scope-id" value={scopeId} onChange={(event) => setScopeId(event.target.value)} />
          </div>
        ) : null}
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="myrmidon-maintenance-reason">Reason</Label>
          <Input id="myrmidon-maintenance-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="myrmidon-maintenance-timeout">Drain timeout, seconds</Label>
          <Input
            id="myrmidon-maintenance-timeout"
            inputMode="numeric"
            value={drainTimeoutSec}
            onChange={(event) => setDrainTimeoutSec(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="myrmidon-maintenance-on-timeout">After the timeout</Label>
          <select
            id="myrmidon-maintenance-on-timeout"
            className={SELECT_CLASS}
            value={onTimeout}
            onChange={(event) => setOnTimeout(event.target.value as MaintenanceOnTimeout)}
          >
            <option value="wait">Keep waiting for running runs</option>
            <option value="interrupt_and_retry">Interrupt running runs and retry them after maintenance</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <Button type="submit" size="sm" disabled={!canEnter}>
            Enter maintenance
          </Button>
        </div>
      </form>
    </section>
  );
}

export function MaintenanceSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: maintenanceQueryKey,
    queryFn: () => maintenanceApi.get(),
    refetchInterval: 10_000,
    retry: false,
  });
  const onSettled = async () => {
    await queryClient.invalidateQueries({ queryKey: maintenanceQueryKey });
  };
  const onError = (err: unknown) => setError(err instanceof Error ? err.message : "Maintenance request failed.");
  const enter = useMutation({ mutationFn: maintenanceApi.enter, onMutate: () => setError(null), onError, onSettled });
  const exit = useMutation({ mutationFn: maintenanceApi.exit, onMutate: () => setError(null), onError, onSettled });
  return (
    <MaintenanceSettingsPanelView
      status={data}
      onEnter={(input) => enter.mutate(input)}
      onExit={(scope) => exit.mutate(scope)}
      pending={enter.isPending || exit.isPending}
      error={error}
    />
  );
}
