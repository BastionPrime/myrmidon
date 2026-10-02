import { Info } from "lucide-react";

export interface AccessHubUnavailableViewProps {
  title: string;
  description: string;
}

/**
 * "Not available yet" state of the access hub: this instance does not serve
 * the access-hub API (404 or 501 on every route of it).
 *
 * It replaces the whole tab body on purpose — no table, no empty state and no
 * error styling — because nothing on the operator's side is broken and an
 * empty list would read as "you have no accesses".
 */
export function AccessHubUnavailableView({ title, description }: AccessHubUnavailableViewProps) {
  return (
    <div
      role="status"
      data-testid="access-hub-unavailable"
      className="flex max-w-xl flex-col gap-1 rounded-lg border border-border bg-muted/40 p-4"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Info className="h-4 w-4 shrink-0 text-muted-foreground" />
        {title}
      </p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}