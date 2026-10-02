// ui/src/ui2/components/ui2StateViews.tsx
//
// myrmidon(UI2): the state artboards from the operator's design decisions
// (02.10): every ui2 screen must ship empty (done / filtered), skeleton
// loading, error with and without cache, and denied — "no partial numbers
// behind the lock". These primitives are the shared implementation; each
// screen composes them from its own query state (loading / error /
// permission). They are presentation-only: data wiring stays in the screens.
//
// State is never told by color alone — each view carries its icon shape
// (dot / pulse for loading, triangle for error, lock for denied, circle-slash
// for empty), so the tile reads correctly without color vision.

import type { ReactNode } from "react";
import { useUi2I18n } from "../i18n/Ui2I18n";

/** Skeleton loading: shimmer rows, aria-busy, no text that lies about data. */
export function Ui2SkeletonRows({ rows = 3, dense = false }: { rows?: number; dense?: boolean }) {
  return (
    <div className="ui2-skeleton flex flex-col gap-2" role="status" aria-busy="true" data-testid="ui2-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={`ui2-skeleton-row animate-pulse rounded-md bg-muted ${dense ? "h-4" : "h-8"}`}
        >
          <span className="sr-only">…</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Error state. When cached data is present the screen keeps rendering it
 * above this note (error WITH cache = stale data + a soft warning); when
 * there is no cache this view replaces the list entirely (error WITHOUT
 * cache). The message comes from the catalog; `detail` is server-provided
 * text and is rendered as-is.
 */
export function Ui2ErrorState({
  message,
  detail,
  retryLabel,
  onRetry,
  withCache,
}: {
  message: string;
  detail?: string | null;
  retryLabel?: string;
  onRetry?: () => void;
  withCache?: boolean;
}) {
  return (
    <div
      className={`ui2-error-state flex flex-col gap-2 rounded-lg border p-4 ${withCache ? "border-border" : "border-destructive/40"}`}
      role="alert"
      data-testid="ui2-error-state"
    >
      <div className="ui2-error-state-head flex items-center gap-2">
        <span className="ui2-error-state-icon inline-block h-3 w-3 rotate-45 border-b-2 border-l-2 border-current text-destructive" aria-hidden="true" />
        <p className="ui2-error-state-message text-sm font-medium text-destructive">{message}</p>
      </div>
      {detail ? <p className="ui2-error-state-detail font-mono text-xs text-muted-foreground">{detail}</p> : null}
      {onRetry && retryLabel ? (
        <button
          type="button"
          className="ui2-error-state-retry w-fit rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Denied state: the operator decided no partial numbers may show behind a
 * permission lock — this view renders the lock alone, never data fragments.
 */
export function Ui2DeniedState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div
      className="ui2-denied-state flex flex-col items-center gap-1 rounded-lg border border-dashed border-border p-6 text-center"
      data-testid="ui2-denied-state"
    >
      <span className="ui2-denied-state-icon inline-flex h-4 w-4 items-center justify-center rounded-sm border border-current text-muted-foreground" aria-hidden="true">
        <span className="h-1.5 w-1.5 bg-current" style={{ borderRadius: "var(--myr-radius-sm)" }} />
      </span>
      <p className="ui2-denied-state-message text-sm font-medium">{message}</p>
      {hint ? <p className="ui2-denied-state-hint text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Empty state with a reason: "done" (everything handled) vs "filtered"
 * (this filter has nothing, others may). The icon is a circle-slash shape,
 * not just muted color.
 */
export function Ui2EmptyStateView({
  title,
  body,
  variant,
}: {
  title: string;
  body?: string;
  variant: "done" | "filtered";
}) {
  const { t } = useUi2I18n();
  return (
    <div
      className="ui2-empty-state flex flex-col items-center gap-1 rounded-lg border border-dashed border-border p-6 text-center"
      data-testid="ui2-empty-state"
      data-variant={variant}
    >
      <span className="ui2-empty-state-icon inline-block h-4 w-4 rounded-full border-2 border-current text-muted-foreground" aria-hidden="true" />
      <p className="ui2-empty-state-title text-sm font-medium">{title}</p>
      {body ? <p className="ui2-empty-state-body text-xs text-muted-foreground">{body}</p> : null}
      <span className="sr-only">{variant === "done" ? t("ui2.common.emptyDoneSr") : t("ui2.common.emptyFilteredSr")}</span>
    </div>
  );
}

/** Wrap a screen body region so screens get a consistent state slot. */
export function Ui2StateRegion({ children }: { children: ReactNode }) {
  return <div className="ui2-state-region flex flex-col gap-3">{children}</div>;
}
