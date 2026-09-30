// myrmidon(EGRESS-B): the "Egress" section of a project's configuration.
//
// A project's list and its mode: journal only (record everything, refuse
// nothing) or blocking (refuse what is on neither the project's list nor the
// bot's). The switch into blocking is gated on the list having been compared
// with the observation journal — the plan's risk note, as a disabled control
// with the reason in front of the person rather than a refused save.
//
// The refusals shown here are the proxy's recent tail, read through the board
// (the durable record is the proxy's journal). It is what makes a refusal
// visible in the interface rather than only in `docker logs`.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CollapsibleSection, Field, ToggleField } from "../agent-config-primitives";
import { useCompany } from "../../context/CompanyContext";
import { botEgressApi, type ProjectEgressView } from "./botEgressApi";
import {
  blockGateReason,
  describeEffective,
  describeRefusal,
  formatAllowlistText,
  parseAllowlistText,
} from "./botEgressConfig";

export const projectEgressKey = (companyId: string) => ["myrmidon", "bot-egress", companyId] as const;
export const projectEgressRefusalsKey = (companyId: string) => ["myrmidon", "bot-egress", "refusals", companyId] as const;

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export interface ProjectEgressFieldsViewProps {
  project: ProjectEgressView | null;
  allowText: string;
  verified: boolean;
  mode: "log" | "block";
  saving: boolean;
  unsaved: boolean;
  error: string | null;
  refusals: string[];
  refusalsError: string | null;
  onAllowText: (text: string) => void;
  onVerified: (verified: boolean) => void;
  onMode: (mode: "log" | "block") => void;
  onSave: () => void;
}

export function ProjectEgressFieldsView({
  project,
  allowText,
  verified,
  mode,
  saving,
  unsaved,
  error,
  refusals,
  refusalsError,
  onAllowText,
  onVerified,
  onMode,
  onSave,
}: ProjectEgressFieldsViewProps) {
  const parsed = parseAllowlistText(allowText);
  const gate = blockGateReason({ verified, entries: parsed.entries });
  const blocking = mode === "block";
  const stored = project;

  return (
    <CollapsibleSection title="Egress" open onToggle={() => {}}>
      <div className="space-y-3" data-testid="myrmidon-project-egress">
        <p className="text-xs text-muted-foreground">
          Where this project's bots may go. The proxy records everything a bot reaches; a blocking project refuses a
          destination that is on neither this list nor the bot's own list.
        </p>

        <ToggleField
          label="Blocking"
          hint="Off (journal only) records every destination and refuses none. On refuses what is on no list. The list must be marked verified first."
          checked={blocking}
          onChange={(on) => onMode(on ? "block" : "log")}
          toggleTestId="myrmidon-project-egress-blocking"
        />
        {blocking && gate !== null && (
          <p className="text-xs text-amber-400" data-testid="myrmidon-project-egress-gate">
            {gate}
          </p>
        )}

        <Field label="Verified against the observation journal" hint="Tick only after comparing this list with what the proxy actually recorded for the project.">
          <ToggleField
            label="Verified"
            checked={verified}
            onChange={onVerified}
            toggleTestId="myrmidon-project-egress-verified"
          />
        </Field>

        <Field label="Allowed destinations" hint="One per line: host or host:port. A bare host means every port on it.">
          <textarea
            className={`${inputClass} min-h-24`}
            aria-label="Allowed destinations"
            data-testid="myrmidon-project-egress-allow"
            value={allowText}
            onChange={(event) => onAllowText(event.target.value)}
            placeholder={"api.example.com\nmedia.example.com:8443"}
          />
        </Field>
        {parsed.problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-amber-400" data-testid="myrmidon-project-egress-problems">
            {parsed.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSave}
            disabled={saving || !unsaved || parsed.problems.length > 0 || (blocking && gate !== null)}
            data-testid="myrmidon-project-egress-save"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          {stored && (
            <span className="text-xs text-muted-foreground" data-testid="myrmidon-project-egress-state">
              {describeEffective(stored.mode, stored.effectiveMode)}
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-destructive" data-testid="myrmidon-project-egress-error">
            {error}
          </p>
        )}

        {blocking && (
          <div className="rounded-md border border-border px-2.5 py-2">
            <div className="text-xs text-muted-foreground">Recent refusals</div>
            {refusalsError ? (
              <p className="text-xs text-muted-foreground" data-testid="myrmidon-project-egress-refusals-error">
                The refusal feed is unavailable: {refusalsError}
              </p>
            ) : refusals.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="myrmidon-project-egress-refusals-empty">
                Nothing has been refused yet.
              </p>
            ) : (
              <ul className="space-y-0.5 text-sm font-mono" data-testid="myrmidon-project-egress-refusals">
                {refusals.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** The connected section: reads the project's policy, saves it, shows refusals. */
export function ProjectEgressFields({ projectId }: { projectId: string }) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [allowText, setAllowText] = useState("");
  const [verified, setVerified] = useState(false);
  const [mode, setMode] = useState<"log" | "block">("log");
  const [error, setError] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: [...projectEgressKey(selectedCompanyId ?? "none")],
    queryFn: () => botEgressApi.list(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const project = policies.data?.projects.find((entry) => entry.projectId === projectId) ?? null;
  const storedMode = project?.mode ?? "log";
  const storedVerified = project?.verified ?? false;
  const storedAllow = project?.allow ?? [];

  // The draft follows the stored row, so a load or a save resets the form.
  const storedKey = JSON.stringify([storedMode, storedVerified, storedAllow]);
  useEffect(() => {
    const [nextMode, nextVerified, nextAllow] = JSON.parse(storedKey) as ["log" | "block", boolean, string[]];
    setMode(nextMode);
    setVerified(nextVerified);
    setAllowText(formatAllowlistText(nextAllow));
  }, [storedKey]);

  const refusals = useQuery({
    queryKey: [...projectEgressRefusalsKey(selectedCompanyId ?? "none")],
    queryFn: () => botEgressApi.refusals(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId) && storedMode === "block",
    retry: false,
  });

  const save = useMutation({
    mutationFn: async () => {
      const parsed = parseAllowlistText(allowText);
      await botEgressApi.saveProject(selectedCompanyId as string, projectId, {
        mode,
        verified,
        allow: parsed.entries,
      });
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: projectEgressKey(selectedCompanyId ?? "none") });
      void queryClient.invalidateQueries({ queryKey: projectEgressRefusalsKey(selectedCompanyId ?? "none") });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "The save failed."),
  });

  const unsaved =
    mode !== storedMode ||
    verified !== storedVerified ||
    parseAllowlistText(allowText).entries.join(",") !== storedAllow.join(",");

  return (
    <ProjectEgressFieldsView
      project={project}
      allowText={allowText}
      verified={verified}
      mode={mode}
      saving={save.isPending}
      unsaved={unsaved}
      error={error}
      refusals={(refusals.data?.refusals ?? []).slice(-20).map(describeRefusal)}
      refusalsError={
        refusals.isError
          ? refusals.error instanceof Error
            ? refusals.error.message
            : "the request failed"
          : null
      }
      onAllowText={setAllowText}
      onVerified={setVerified}
      onMode={setMode}
      onSave={() => {
        setError(null);
        save.mutate();
      }}
    />
  );
}