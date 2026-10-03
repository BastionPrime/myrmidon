// myrmidon(1.6.1 WIP-LIMIT B): the WIP badge shown on an agent row of the
// agents list. Read-only: it renders one entry of the status endpoint
// (wip/limit, red when over the limit). The limit itself is edited on the
// "WIP limit" settings screen; the badge just answers "how loaded is this
// agent right now".
import { wipBadgeText } from "./wip-limit/wipLimitConfig";
import type { WipLimitStatusEntry } from "./wip-limit/wipLimitApi";

export function AgentWipBadge({ status }: { status: WipLimitStatusEntry | undefined }) {
  if (!status) return null;
  return (
    <span
      data-testid={`agent-wip-badge-${status.agentId}`}
      data-over-limit={status.overLimit ? "true" : undefined}
      title={status.overLimit ? "Over the WIP limit" : "Tasks in work (in progress + in review)"}
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap " +
        (status.overLimit
          ? "bg-destructive/10 text-destructive"
          : "bg-muted text-muted-foreground")
      }
    >
      {status.overLimit ? (
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden />
      ) : null}
      <span className="font-mono">{wipBadgeText(status)}</span>
    </span>
  );
}