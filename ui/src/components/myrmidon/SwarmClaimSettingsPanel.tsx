// Swarm claim pilot settings (myrmidon 1.6.1, SWARM-SETTINGS-UI): the
// "Role queues (SWARM-CLAIM)" section of Instance → General. The master
// switch, the role/company pilot set, the lease TTL, the per-agent ceiling,
// the sweep interval and the P0 preemption, each with its origin (saved here,
// environment override, default). Saving writes the instance settings row;
// the server re-reads it on every claim, checkout and sweep tick, so a change
// applies within a minute without a restart. Switching the pilot off frees
// the live leases at once (the PATCH response reports how many).
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { SwarmClaimSettingsPatch, SwarmClaimSettingSource } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  describeSwarmClaimSource,
  swarmClaimSettingsApi,
  swarmClaimSettingsQueryKey,
  type SwarmClaimSettingsView,
} from "./swarmClaimSettingsApi";

interface DraftParse {
  patch: SwarmClaimSettingsPatch | null;
  errors: Partial<Record<string, string>>;
}

const NUMBER_FIELDHints = {
  leaseTtlSec: "How long one lease lives without a heartbeat, in seconds (60–86400).",
  maxActiveTasks: "Ceiling of live claims per agent; empty = no ceiling.",
  sweepIntervalSec: "How often the expired-lease sweep runs, in seconds (minimum 5).",
} as const;

/**
 * Parse the numeric draft fields. An empty field means "no ceiling" for the
 * limit; everything else must be a whole number in the documented range.
 */
export function parseSwarmClaimDraft(draft: {
  leaseTtlSec: string;
  maxActiveTasks: string;
  sweepIntervalSec: string;
}): Pick<DraftParse, "patch" | "errors"> {
  const errors: Partial<Record<string, string>> = {};

  const ttlRaw = draft.leaseTtlSec.trim();
  const ttl = ttlRaw ? Number(ttlRaw) : Number.NaN;
  if (!ttlRaw || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    errors.leaseTtlSec = "Enter a whole number from 60 to 86400";
  }

  const maxRaw = draft.maxActiveTasks.trim();
  let maxActiveTasks: number | null = null;
  if (maxRaw) {
    const value = Number(maxRaw);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      errors.maxActiveTasks = "Enter a whole number from 1 to 100, or leave it empty for no ceiling";
    } else {
      maxActiveTasks = value;
    }
  }

  const sweepRaw = draft.sweepIntervalSec.trim();
  const sweep = sweepRaw ? Number(sweepRaw) : Number.NaN;
  if (!sweepRaw || !Number.isInteger(sweep) || sweep < 5) {
    errors.sweepIntervalSec = "Enter a whole number of at least 5";
  }

  if (Object.keys(errors).length > 0) return { patch: null, errors };

  return {
    patch: {
      leaseTtlSec: ttl,
      maxActiveTasks,
      sweepIntervalSec: sweep,
    },
    errors,
  };
}

function toDraftNumbers(settings: {
  leaseTtlSec: number;
  maxActiveTasks: number | null;
  sweepIntervalSec: number;
}) {
  return {
    leaseTtlSec: String(settings.leaseTtlSec),
    maxActiveTasks: settings.maxActiveTasks === null ? "" : String(settings.maxActiveTasks),
    sweepIntervalSec: String(settings.sweepIntervalSec),
  };
}

export function SwarmClaimSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: SwarmClaimSettingsView | null | undefined;
  onSave: (patch: SwarmClaimSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draftNumbers, setDraftNumbers] = useState<ReturnType<typeof toDraftNumbers> | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftP0, setDraftP0] = useState<boolean | null>(null);
  const [draftRoles, setDraftRoles] = useState<string | null>(null);
  const [draftCompanyIds, setDraftCompanyIds] = useState<string | null>(null);

  const numbers = draftNumbers ?? (view ? toDraftNumbers(view.settings) : null);
  const enabled = draftEnabled ?? (view ? view.settings.enabled : false);
  const p0Preemption = draftP0 ?? (view ? view.settings.p0Preemption : true);
  const roles = draftRoles ?? (view ? view.settings.enabledRoles.join(", ") : "");
  const companyIds = draftCompanyIds ?? (view ? view.settings.enabledCompanyIds.join(", ") : "");

  const { patch: numberPatch, errors } = numbers
    ? parseSwarmClaimDraft(numbers)
    : { patch: null, errors: {} as Partial<Record<string, string>> };

  const rolesList = roles
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const companyIdsList = companyIds
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const rolesError =
    rolesList.length > 200 ? "At most 200 roles" : null;
  const companyIdsError =
    companyIdsList.length > 200 ? "At most 200 company ids" : null;

  const canSave =
    Boolean(numberPatch) && !rolesError && !companyIdsError && view !== null && view !== undefined;
  const patch: SwarmClaimSettingsPatch | null = numberPatch
    ? {
        ...numberPatch,
        enabled,
        p0Preemption,
        enabledRoles: rolesList,
        enabledCompanyIds: companyIdsList,
      }
    : null;

  const source = (key: string) =>
    view
      ? describeSwarmClaimSource(
          (view.sources as Record<string, string | undefined>)[key] as
            | SwarmClaimSettingSource
            | undefined,
        )
      : "";

  return (
    <section className="space-y-4" data-testid="myrmidon-swarm-claim-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Role queues (SWARM-CLAIM)</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The pilot of the per-role task queues: an agent claims the top task of its own
          role&apos;s queue behind a lease. Every value applies without a restart — the server
          re-reads these settings on each claim and sweep tick. Turning the pilot off releases
          the live leases immediately. Environment variables stay forced overrides; each field
          shows whether the saved value or the override is in force.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="swarm-claim-enabled">Enable role queues</Label>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="swarm-claim-source-enabled">{source("enabled")}</span>
                </p>
              </div>
              <ToggleSwitch
                id="swarm-claim-enabled"
                checked={enabled}
                onCheckedChange={setDraftEnabled}
                data-testid="swarm-claim-enabled-toggle"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="swarm-claim-roles">Pilot roles</Label>
            <Input
              id="swarm-claim-roles"
              placeholder="Empty = every role"
              value={roles}
              onChange={(event) => setDraftRoles(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="swarm-claim-source-enabledRoles">{source("enabledRoles")}</span>
              {rolesError ? (
                <span data-testid="swarm-claim-error-enabledRoles" className="ml-2 text-destructive">
                  {rolesError}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Comma-separated role names (e.g. engineer). The pilot only these roles claim from;
              empty means every role. The company field below narrows it further.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="swarm-claim-companies">Pilot companies</Label>
            <Input
              id="swarm-claim-companies"
              placeholder="Empty = every company"
              value={companyIds}
              onChange={(event) => setDraftCompanyIds(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid="swarm-claim-source-enabledCompanyIds">
                {source("enabledCompanyIds")}
              </span>
              {companyIdsError ? (
                <span
                  data-testid="swarm-claim-error-enabledCompanyIds"
                  className="ml-2 text-destructive"
                >
                  {companyIdsError}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Comma-separated company ids. Empty means every company.
            </p>
          </div>

          {(["leaseTtlSec", "maxActiveTasks", "sweepIntervalSec"] as const).map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`swarm-claim-${key}`}>
                {key === "leaseTtlSec"
                  ? "Lease TTL, seconds"
                  : key === "maxActiveTasks"
                    ? "Max active tasks per agent"
                    : "Sweep interval, seconds"}
              </Label>
              <Input
                id={`swarm-claim-${key}`}
                inputMode="numeric"
                placeholder={key === "maxActiveTasks" ? "No ceiling" : "Required"}
                value={numbers ? numbers[key] : ""}
                onChange={(event) =>
                  setDraftNumbers({ ...(numbers ?? toDraftNumbers(view.settings)), [key]: event.target.value })
                }
              />
              <div className="text-xs text-muted-foreground">
                <span data-testid={`swarm-claim-source-${key}`}>{source(key)}</span>
                {errors[key] ? (
                  <span data-testid={`swarm-claim-error-${key}`} className="ml-2 text-destructive">
                    {errors[key]}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {NUMBER_FIELDHints[key]}
              </p>
            </div>
          ))}

          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="swarm-claim-p0">P0 preempts the queue</Label>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="swarm-claim-source-p0Preemption">{source("p0Preemption")}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  On — a critical task is the top of the queue. Off — the queue is strictly
                  oldest-first.
                </p>
              </div>
              <ToggleSwitch
                id="swarm-claim-p0"
                checked={p0Preemption}
                onCheckedChange={setDraftP0}
                data-testid="swarm-claim-p0-toggle"
              />
            </div>
          </div>

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || !canSave || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? "Saving..." : "Save role queue settings"}
            </Button>
          </div>

          <div className="space-y-1 md:col-span-2" data-testid="swarm-claim-journal">
            <h3 className="text-sm font-medium">Change journal</h3>
            <p className="text-xs text-muted-foreground">
              Who changed the pilot settings, and when (newest first).
            </p>
            {view.journal.length === 0 ? (
              <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
            ) : (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {view.journal.slice(0, 10).map((entry) => (
                  <li key={entry.at + entry.actorId} data-testid="swarm-claim-journal-entry">
                    <span className="font-mono">{new Date(entry.at).toLocaleString()}</span>
                    {" — "}
                    <span className="font-mono">{entry.actorType}:{entry.actorId}</span>
                    {" — "}
                    {Object.keys(entry.patch).join(", ") || "(no keys)"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading role queue settings...</p>
      )}
    </section>
  );
}

export function SwarmClaimSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [releasedNote, setReleasedNote] = useState<string | null>(null);
  const query = useQuery({
    queryKey: swarmClaimSettingsQueryKey,
    queryFn: () => swarmClaimSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: swarmClaimSettingsApi.update,
    onMutate: () => {
      setError(null);
      setReleasedNote(null);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Saving the role queue settings failed."),
    onSuccess: async (data) => {
      setError(null);
      setReleasedNote(
        typeof data.releasedClaims === "number" && data.releasedClaims > 0
          ? `Pilot switched off: ${data.releasedClaims} live lease(s) released.`
          : null,
      );
      await queryClient.invalidateQueries({ queryKey: swarmClaimSettingsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load role queue settings."}
      </div>
    );
  }

  const banner = error ?? releasedNote;

  return (
    <SwarmClaimSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={banner}
    />
  );
}
