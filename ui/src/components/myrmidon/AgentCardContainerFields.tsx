import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CollapsibleSection, DraftInput, Field, ToggleField } from "../agent-config-primitives";
import {
  botContainerApi,
  botContainerStatusKey,
  describeApplyError,
  describeApplyOutcome,
  type ApplyFeedback,
  type BotContainerStatus,
} from "./botContainerApi";
import {
  BOT_CONTAINER_NUMBER_FIELDS,
  botContainerProblems,
  disableBotContainer,
  enableBotContainer,
  parseBotContainerNumber,
  readBotContainerCard,
  setBotContainerNumber,
  setBotContainerText,
  type BotContainerCard,
  type BotContainerNumberField,
} from "./botContainerConfig";

/**
 * myrmidon(W2b): the "Container" section of a hermes_gateway agent card. Stored as
 * `adapterConfig.container = { enabled, image, memoryMb, cpus, pidsLimit, group? }`.
 * Saving the card stores the settings; "Apply now" asks the server to reconcile the
 * SAVED card with the bot's container (create it, refresh its profile, restart the
 * gateway), so it is off while the section has unsaved edits.
 */

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const NUMBER_FIELD_ORDER: BotContainerNumberField[] = ["memoryMb", "cpus", "pidsLimit"];

function NumberField({
  field,
  value,
  onCommit,
}: {
  field: BotContainerNumberField;
  value: unknown;
  onCommit: (value: number) => void;
}) {
  const spec = BOT_CONTAINER_NUMBER_FIELDS[field];
  const shown = typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const parsed = parseBotContainerNumber(field, draft);
  return (
    <Field label={`${spec.label} (${spec.unit})`}>
      <input
        type="text"
        inputMode={spec.integer ? "numeric" : "decimal"}
        className={inputClass}
        aria-label={spec.label}
        aria-invalid={!parsed.ok}
        data-testid={`myrmidon-bot-container-${field}`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          // Only a valid number reaches the card; an invalid draft keeps the last valid value.
          const next = parseBotContainerNumber(field, event.target.value);
          if (next.ok) onCommit(next.value);
        }}
      />
      {!parsed.ok && (
        <p className="mt-1 text-xs text-amber-400" data-testid={`myrmidon-bot-container-${field}-error`}>
          {parsed.message}
        </p>
      )}
    </Field>
  );
}

function stateLabel(state: "running" | "stopped" | "missing" | "unhealthy"): string {
  switch (state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "unhealthy":
      return "Unhealthy";
    default:
      return "Not created yet";
  }
}

function statusText(status: BotContainerStatus | null, statusError: string | null): string {
  if (!status) return statusError ? `Container status unavailable: ${statusError}` : "Checking container status...";
  if (!status.enabled) return "Bot containers are switched off on this instance: nothing here is applied.";
  if (!status.runtimeConfigured) return "No container runtime is configured on this instance yet.";
  if (status.containerError) return `Container status unavailable: ${status.containerError}`;
  if (!status.container) return "Container status is not available for this agent.";
  const image = status.container.image ? ` (${status.container.image})` : "";
  return `${stateLabel(status.container.state)}${image}`;
}

/** Why "Apply now" cannot run right now, or null when it can. */
export function applyBlockedReason(
  status: BotContainerStatus | null,
  unsaved: boolean,
  statusError: string | null,
): string | null {
  if (unsaved) return "Save the card first: Apply now uses the saved settings.";
  if (!status) return statusError ? "Container status is unavailable." : "Checking container status...";
  if (!status.enabled) return "Bot containers are not enabled on this instance.";
  if (!status.runtimeConfigured) return "The bot container runtime is not configured on this instance.";
  if (!status.eligible) return `The saved card cannot be applied: ${status.reason ?? "it is not a complete container config."}`;
  return null;
}

export interface AgentCardContainerFieldsViewProps {
  /** `adapterConfig.container` as currently edited. */
  value: unknown;
  onChange: (next: BotContainerCard | undefined) => void;
  /** The section (or the adapter) has edits that are not saved yet. */
  unsaved: boolean;
  status: BotContainerStatus | null;
  statusError: string | null;
  applying: boolean;
  feedback: ApplyFeedback | null;
  onApply: () => void;
  onRefresh: () => void;
}

export function AgentCardContainerFieldsView({
  value,
  onChange,
  unsaved,
  status,
  statusError,
  applying,
  feedback,
  onApply,
  onRefresh,
}: AgentCardContainerFieldsViewProps) {
  const card = readBotContainerCard(value);
  const enabled = card.enabled === true;
  const [expanded, setExpanded] = useState(() => Object.keys(card).length > 0);
  const problems = botContainerProblems(card);
  const blocked = applyBlockedReason(status, unsaved, statusError);
  const image = typeof card.image === "string" ? card.image : "";
  const group = typeof card.group === "string" ? card.group : "";
  const allowlist = status?.imageAllowlist ?? null;
  // The server judges the SAVED image; an edited one is judged after saving.
  const savedImageNotAllowed = status?.imageAllowed === false && !unsaved;

  return (
    <CollapsibleSection title="Container" open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3" data-testid="myrmidon-bot-container">
        <ToggleField
          label="Enabled"
          hint="Run this agent's gateway in its own container with the limits below. Off leaves the agent as it is."
          checked={enabled}
          onChange={(on) => onChange(on ? enableBotContainer(card) : disableBotContainer(card))}
          toggleTestId="myrmidon-bot-container-enabled"
        />

        {enabled && (
          <>
            <Field label="Image" hint="The bot image to run. Only images the instance allows can be applied.">
              <DraftInput
                value={image}
                onCommit={(text) => onChange(setBotContainerText(card, "image", text))}
                immediate
                className={inputClass}
                placeholder="registry/name:tag"
                aria-label="Image"
                data-testid="myrmidon-bot-container-image"
              />
              {allowlist !== null && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="myrmidon-bot-container-allowlist">
                  {allowlist.length > 0
                    ? `Allowed on this instance: ${allowlist.join(", ")}`
                    : "This instance allows no images yet, so nothing can be applied."}
                </p>
              )}
              {savedImageNotAllowed && (
                <p className="mt-1 text-xs text-amber-400" data-testid="myrmidon-bot-container-image-not-allowed">
                  The saved image is not on the allowlist and will be refused.
                </p>
              )}
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {NUMBER_FIELD_ORDER.map((field) => (
                <NumberField
                  key={field}
                  field={field}
                  value={card[field]}
                  onCommit={(next) => onChange(setBotContainerNumber(card, field, next))}
                />
              ))}
            </div>

            <Field label="Group" hint="Empty means the agent gets its own container.">
              <DraftInput
                value={group}
                onCommit={(text) => onChange(setBotContainerText(card, "group", text))}
                immediate
                className={inputClass}
                placeholder="Empty: own container"
                aria-label="Group"
                data-testid="myrmidon-bot-container-group"
              />
              {group && (
                <p className="mt-1 text-xs text-amber-400" data-testid="myrmidon-bot-container-group-warning">
                  Shared containers are not supported yet: the container will not be applied while Group is set.
                </p>
              )}
            </Field>
          </>
        )}

        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-amber-400" data-testid="myrmidon-bot-container-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-md border border-border px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Container status</div>
              <div className="break-words text-sm" data-testid="myrmidon-bot-container-status">
                {statusText(status, statusError)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                disabled={applying}
                data-testid="myrmidon-bot-container-refresh"
              >
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onApply}
                disabled={applying || blocked !== null}
                title={blocked ?? undefined}
                data-testid="myrmidon-bot-container-apply"
              >
                {applying ? "Applying..." : "Apply now"}
              </Button>
            </div>
          </div>
          {blocked && (
            <p className="text-xs text-muted-foreground" data-testid="myrmidon-bot-container-apply-hint">
              {blocked}
            </p>
          )}
          {feedback && (
            <p
              role="status"
              className={
                feedback.kind === "ok"
                  ? "text-xs text-green-500"
                  : feedback.kind === "warn"
                    ? "text-xs text-amber-400"
                    : "text-xs text-destructive"
              }
              data-testid="myrmidon-bot-container-feedback"
            >
              {feedback.message}
            </p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}

/** The connected section: reads the status, runs "Apply now". */
export function AgentCardContainerFields({
  agentId,
  value,
  savedValue,
  unsaved,
  onChange,
}: {
  agentId: string;
  /** `adapterConfig.container` as edited in the form. */
  value: unknown;
  /** `adapterConfig.container` as saved: the status is asked again when it changes. */
  savedValue: unknown;
  unsaved: boolean;
  onChange: (next: BotContainerCard | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const savedKey = JSON.stringify(savedValue ?? null);
  const statusQuery = useQuery({
    queryKey: [...botContainerStatusKey(agentId), savedKey],
    queryFn: () => botContainerApi.status(agentId),
    retry: false,
  });
  const [feedback, setFeedback] = useState<ApplyFeedback | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: botContainerStatusKey(agentId) });
  const apply = useMutation({
    mutationFn: () => botContainerApi.apply(agentId),
    onSuccess: (result) => {
      setFeedback(describeApplyOutcome(result.outcome));
      void refresh();
    },
    onError: (error) => {
      setFeedback(describeApplyError(error));
      void refresh();
    },
  });

  return (
    <AgentCardContainerFieldsView
      value={value}
      onChange={onChange}
      unsaved={unsaved}
      status={statusQuery.data ?? null}
      statusError={
        statusQuery.isError
          ? statusQuery.error instanceof Error
            ? statusQuery.error.message
            : "The status request failed."
          : null
      }
      applying={apply.isPending}
      feedback={feedback}
      onApply={() => {
        setFeedback(null);
        apply.mutate();
      }}
      onRefresh={() => void refresh()}
    />
  );
}
