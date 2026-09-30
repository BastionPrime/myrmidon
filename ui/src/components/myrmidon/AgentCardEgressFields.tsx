// myrmidon(EGRESS-B): the "Egress" section of a bot's card.
//
// Two things live here, and both are the bot's own rather than its project's:
// which project the journal should name for it (the project whose list applies
// to it), and the destinations only this bot may reach — added to the
// project's list, never replacing it. A project's own list and mode are edited
// on the project page; here the project is only picked.
//
// Saving is immediate (there is no unsaved-edit model in this section): the
// policy is read by the proxy on its own timer, so a save is one small request.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import { useCompany } from "../../context/CompanyContext";
import { botEgressApi } from "./botEgressApi";
import { formatAllowlistText, parseAllowlistText } from "./botEgressConfig";
import { projectEgressKey } from "./ProjectEgressFields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export interface AgentCardEgressFieldsViewProps {
  projectNames: string[];
  project: string;
  allowText: string;
  saving: boolean;
  error: string | null;
  savedNote: string | null;
  onProject: (project: string) => void;
  onAllowText: (text: string) => void;
  onSave: () => void;
}

export function AgentCardEgressFieldsView({
  projectNames,
  project,
  allowText,
  saving,
  error,
  savedNote,
  onProject,
  onAllowText,
  onSave,
}: AgentCardEgressFieldsViewProps) {
  const parsed = parseAllowlistText(allowText);
  return (
    <CollapsibleSection title="Egress" open onToggle={() => {}}>
      <div className="space-y-3" data-testid="myrmidon-agent-egress">
        <p className="text-xs text-muted-foreground">
          Which project this bot belongs to in the egress journal, and the destinations only this bot may reach. The
          project's own list and its journal-or-blocking mode are edited on the project page.
        </p>

        <Field label="Project" hint="The project whose egress list applies to this bot. Empty means no project list applies.">
          <select
            className={inputClass}
            aria-label="Project"
            data-testid="myrmidon-agent-egress-project"
            value={project}
            onChange={(event) => onProject(event.target.value)}
          >
            <option value="">No project</option>
            {projectNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="This bot's own destinations" hint="One per line: host or host:port. Added to the project's list.">
          <textarea
            className={`${inputClass} min-h-20`}
            aria-label="This bot's own destinations"
            data-testid="myrmidon-agent-egress-allow"
            value={allowText}
            onChange={(event) => onAllowText(event.target.value)}
            placeholder={"other.example.com"}
          />
        </Field>
        {parsed.problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-amber-400" data-testid="myrmidon-agent-egress-problems">
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
            disabled={saving || parsed.problems.length > 0}
            data-testid="myrmidon-agent-egress-save"
          >
            {saving ? "Saving..." : "Save egress"}
          </Button>
          {savedNote && (
            <span className="text-xs text-muted-foreground" data-testid="myrmidon-agent-egress-saved">
              {savedNote}
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-destructive" data-testid="myrmidon-agent-egress-error">
            {error}
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** The connected section: reads the company's policies, saves this bot's own. */
export function AgentCardEgressFields({ agentId }: { agentId: string }) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [project, setProject] = useState("");
  const [allowText, setAllowText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: [...projectEgressKey(selectedCompanyId ?? "none")],
    queryFn: () => botEgressApi.list(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const stored = policies.data?.bots.find((entry) => entry.botKey === agentId) ?? null;
  const storedKey = JSON.stringify([stored?.project ?? "", stored?.allow ?? []]);
  useEffect(() => {
    const [nextProject, nextAllow] = JSON.parse(storedKey) as [string, string[]];
    setProject(nextProject);
    setAllowText(formatAllowlistText(nextAllow));
  }, [storedKey]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = parseAllowlistText(allowText);
      await botEgressApi.saveBot(selectedCompanyId as string, agentId, { project, allow: parsed.entries });
    },
    onSuccess: () => {
      setError(null);
      setSavedNote("Saved");
      void queryClient.invalidateQueries({ queryKey: projectEgressKey(selectedCompanyId ?? "none") });
    },
    onError: (err) => {
      setSavedNote(null);
      setError(err instanceof Error ? err.message : "The save failed.");
    },
  });

  const projectNames = (policies.data?.projects ?? []).map((entry) => entry.name);

  return (
    <AgentCardEgressFieldsView
      projectNames={projectNames}
      project={project}
      allowText={allowText}
      saving={save.isPending}
      error={error}
      savedNote={savedNote}
      onProject={(next) => {
        setProject(next);
        setSavedNote(null);
      }}
      onAllowText={(next) => {
        setAllowText(next);
        setSavedNote(null);
      }}
      onSave={() => {
        setError(null);
        setSavedNote(null);
        save.mutate();
      }}
    />
  );
}