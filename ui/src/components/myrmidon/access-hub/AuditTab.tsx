import { ScrollText } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  DEFAULT_AUDIT_LIMIT,
  formatAccessMoment,
  latestAuditEntries,
  type AccessAuditEntry,
} from "./accessHubApi";

export interface AuditTabViewProps {
  entries: AccessAuditEntry[];
  /** How many of the newest journal lines to show. */
  limit?: number;
  loading?: boolean;
  error?: string | null;
}

/**
 * The journal: who touched which access, when, and which version came out of
 * it. Journal lines carry names and versions — never values.
 */
export function AuditTabView({ entries, limit = DEFAULT_AUDIT_LIMIT, loading = false, error = null }: AuditTabViewProps) {
  const visible = latestAuditEntries(entries, limit);

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (!loading && visible.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        message="Nothing in the journal yet. Creating, granting, rotating and deploying accesses all land here."
      />
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto" data-testid="access-hub-audit">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-3 font-medium">When</th>
            <th scope="col" className="py-2 pr-3 font-medium">Actor</th>
            <th scope="col" className="py-2 pr-3 font-medium">Action</th>
            <th scope="col" className="py-2 pr-3 font-medium">Access</th>
            <th scope="col" className="py-2 pr-3 font-medium">Target</th>
            <th scope="col" className="py-2 pr-3 font-medium">Version</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry, index) => (
            <tr
              key={`${entry.at}:${entry.actor}:${entry.action}:${entry.secretName}:${index}`}
              data-testid="access-hub-audit-row"
              className="border-b border-border/60"
            >
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{formatAccessMoment(entry.at)}</td>
              <td className="py-2 pr-3">{entry.actor}</td>
              <td className="py-2 pr-3">{entry.action}</td>
              <td className="py-2 pr-3">{entry.secretName}</td>
              <td className="py-2 pr-3 text-muted-foreground">{entry.targetName ?? "—"}</td>
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                {typeof entry.version === "number" ? `v${entry.version}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}