// ui/src/ui2/components/ui2Primitives.tsx
//
// myrmidon(UI2): the small primitive layer for ui2 screens. These wrap the
// vendor shadcn primitives with ui2-namespace class hooks (`ui2-*`) so the
// new screens stay visually distinct from vendor surfaces while consuming
// ONLY token-backed classes (no hex, no arbitrary px) — check:token-gates
// scans `ui/src/components/**` and `ui/src/pages/**`; `ui/src/ui2/**` is not
// on its scan list today, but the same discipline is applied voluntarily so
// the tree can be added to the gate later without a cleanup pass.

import type { ReactNode } from "react";

export function Ui2Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui2-page mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="ui2-page-header flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="ui2-page-title text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="ui2-page-subtitle text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="ui2-page-actions flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="ui2-page-body flex flex-col gap-6">{children}</div>
    </div>
  );
}

export function Ui2Section({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="ui2-section flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="ui2-section-title text-sm font-medium">{title}</h2>
      <div className="ui2-section-body flex flex-col gap-3">{children}</div>
      {footer ? <div className="ui2-section-footer text-xs text-muted-foreground">{footer}</div> : null}
    </section>
  );
}

export function Ui2Tiles({ children }: { children: ReactNode }) {
  return <div className="ui2-tiles grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export function Ui2Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warning" | "danger" | "ok";
}) {
  const toneClass =
    tone === "danger"
      ? "ui2-tile-danger border-destructive/40"
      : tone === "warning"
        ? "ui2-tile-warning border-border"
        : tone === "ok"
          ? "ui2-tile-ok border-border"
          : "border-border";
  return (
    <div className={`ui2-tile flex flex-col gap-1 rounded-lg border bg-card p-4 ${toneClass}`}>
      <span className="ui2-tile-label text-xs text-muted-foreground">{label}</span>
      <span className="ui2-tile-value font-mono text-lg tabular-nums">{value}</span>
      {hint ? <span className="ui2-tile-hint text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function Ui2EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="ui2-empty flex flex-col items-center gap-1 rounded-lg border border-dashed border-border p-6 text-center">
      <p className="ui2-empty-title text-sm font-medium">{title}</p>
      {body ? <p className="ui2-empty-body text-xs text-muted-foreground">{body}</p> : null}
    </div>
  );
}

export function Ui2Loading({ label }: { label: string }) {
  return (
    <div className="ui2-loading flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
      <span className="ui2-loading-dot h-2 w-2 animate-pulse rounded-full bg-muted-foreground" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Ui2ErrorNote({ message, retryLabel, onRetry }: { message: string; retryLabel?: string; onRetry?: () => void }) {
  return (
    <div className="ui2-error flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-card p-3 text-sm" role="alert">
      <span className="ui2-error-message text-destructive">{message}</span>
      {onRetry && retryLabel ? (
        <button type="button" className="ui2-error-retry rounded-md border border-border px-3 py-1 text-xs hover:bg-accent" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function Ui2StatusDot({ tone }: { tone: "ok" | "warning" | "danger" | "muted" }) {
  // Token colors through the shell's signal palette (style vars, not
  // arbitrary bracket classes — check:token-gates scans ui2 too).
  const background =
    tone === "ok"
      ? "var(--myr-signal-live)"
      : tone === "warning"
        ? "var(--myr-signal-warn)"
        : tone === "danger"
          ? "var(--myr-signal-halt)"
          : "var(--myr-ink-muted)";
  return (
    <span className="ui2-status-dot inline-block h-2 w-2 rounded-full" style={{ background }} aria-hidden="true" />
  );
}
