// Maintenance mode (R3) banner, shown in the common layout while a maintenance
// window concerns the current company. Informational only: changes happen in
// Instance settings → General → Maintenance.
//
// 1.6.1 MAINTENANCE-BANNER: however many windows are open (one per agent in a
// batch update, plus instance/company/department ones), the banner stays a
// single plaque. The plaque carries the aggregate state (on / draining /
// ending), the total window count and the "ends by" bound; the details list
// inside stays one line per kind of window. Agent ids are never rendered in
// the collapsed plaque — only counts.
import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { useTranslation } from "@/i18n";
import {
  maintenanceApi,
  maintenanceQueryKey,
  windowsForCompany,
  type MaintenanceStatus,
  type MaintenanceWindowView,
} from "./maintenanceApi";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Reason text without per-agent identifiers, so windows of one kind share a key. */
export function normalizeReason(reason: string): string {
  return reason
    .replace(/\(\s*(?:[0-9a-f-]{36}\s*,?\s*)*\)/gi, "")
    .replace(UUID_PATTERN, "")
    .replace(/\s+/g, " ")
    .replace(/[\s:,;-]+$/, "")
    .trim();
}

/**
 * Roll-up of one or more windows of the same kind: scope type + state +
 * normalized reason. `agentCount` is the number of distinct windows
 * (agent-scoped windows are one-per-agent), `endsBy` is the latest drain
 * deadline of the windows in the row.
 */
export interface MaintenanceRow {
  key: string;
  scopeType: MaintenanceWindowView["scope"]["type"];
  state: MaintenanceWindowView["state"];
  reason: string;
  startedAt: string;
  endsBy: string | null;
  agentCount: number;
  queuedWakeups: number;
  runningRuns: number;
  drainTimedOut: boolean;
  /** Agent ids behind the row, for the expanded details only. */
  ids: string[];
}

export interface AggregatedMaintenance {
  /** One row per kind of window (scope type + state + reason). */
  rows: MaintenanceRow[];
  /** Total number of windows the plaque counts. */
  windowCount: number;
  /** Latest drain deadline across all non-leaving windows, when known. */
  endsBy: string | null;
}

export function aggregateMaintenance(windows: MaintenanceWindowView[]): AggregatedMaintenance {
  const rows = new Map<string, MaintenanceRow>();
  for (const window of windows) {
    const reason = window.state === "leaving" ? "" : normalizeReason(window.reason);
    const key = `${window.state}\u0000${window.scope.type}\u0000${reason}`;
    const row =
      rows.get(key) ??
      {
        key,
        scopeType: window.scope.type,
        state: window.state,
        reason,
        startedAt: window.startedAt,
        endsBy: null,
        agentCount: 0,
        queuedWakeups: 0,
        runningRuns: 0,
        drainTimedOut: false,
        ids: [],
      };
    row.agentCount += 1;
    if (window.scope.type === "agent") row.ids.push(window.scope.id ?? window.id);
    row.queuedWakeups += window.queuedWakeups;
    row.runningRuns += window.runningRuns;
    row.drainTimedOut ||= window.drainTimedOut;
    if (new Date(window.startedAt).getTime() < new Date(row.startedAt).getTime()) row.startedAt = window.startedAt;
    if (!row.endsBy || new Date(window.drainDeadlineAt).getTime() > new Date(row.endsBy).getTime()) {
      row.endsBy = window.drainDeadlineAt;
    }
    rows.set(key, row);
  }
  let endsBy: string | null = null;
  for (const row of rows.values()) {
    if (row.state === "leaving" || !row.endsBy) continue;
    if (!endsBy || new Date(row.endsBy).getTime() > new Date(endsBy).getTime()) endsBy = row.endsBy;
  }
  return { rows: [...rows.values()], windowCount: windows.length, endsBy };
}

function rowIds(row: MaintenanceRow): string | null {
  return row.scopeType === "agent" ? row.ids.join(", ") : null;
}

export function MaintenanceBannerView({
  status,
  companyId,
}: {
  status: MaintenanceStatus | null | undefined;
  companyId: string | null;
}) {
  const { t } = useTranslation();
  const windows = windowsForCompany(status, companyId);
  if (windows.length === 0) return null;

  const stateLabel = (window: { state: MaintenanceWindowView["state"]; runningRuns: number; drainTimedOut: boolean }) => {
    if (window.state === "entering") {
      return t(window.drainTimedOut ? "maintenanceBanner.state.drainingTimedOut" : "maintenanceBanner.state.draining", {
        count: window.runningRuns,
      });
    }
    return t(window.state === "leaving" ? "maintenanceBanner.state.ending" : "maintenanceBanner.state.on");
  };

  const { rows, windowCount, endsBy } = aggregateMaintenance(windows);
  const endsByLabel = endsBy ? ` · ${t("maintenanceBanner.endsBy", { time: new Date(endsBy).toLocaleString() })}` : "";
  return (
    <div
      role="status"
      data-testid="myrmidon-maintenance-banner"
      className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="px-3 py-2 text-sm">
        <details data-testid="myrmidon-maintenance-details">
          <summary className="cursor-pointer list-none">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
                <Wrench className="h-3.5 w-3.5 shrink-0" />
                <span>{t("maintenanceBanner.title")}</span>
              </div>
              <p data-testid="myrmidon-maintenance-summary">
                {t("maintenanceBanner.summary", {
                  count: windowCount,
                  rows: rows.length,
                  state: stateLabel({
                    state: rows.every((r) => r.state === "leaving")
                      ? "leaving"
                      : rows.some((r) => r.state === "entering")
                        ? "entering"
                        : "on",
                    runningRuns: rows.reduce((sum, r) => sum + r.runningRuns, 0),
                    drainTimedOut: rows.some((r) => r.drainTimedOut),
                  }),
                })}
                {endsByLabel}
              </p>
            </div>
          </summary>
          <ul className="mt-1 flex flex-col gap-1 pl-4 text-xs opacity-80">
            {rows.map((row) => (
              <li key={row.key} data-testid="myrmidon-maintenance-row" title={rowIds(row) ?? undefined}>
                {t("maintenanceBanner.row", {
                  scope: t(`maintenanceBanner.scope.${row.scopeType}`),
                  state: stateLabel(row),
                  since: new Date(row.startedAt).toLocaleString(),
                  reason: row.reason,
                  count: row.agentCount,
                  queued: row.queuedWakeups,
                })}
                {rowIds(row) ? (
                  <span className="block pl-2 opacity-70">{t("maintenanceBanner.idsSummary")}: {rowIds(row)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

export function MaintenanceBanner({ companyId }: { companyId: string | null }) {
  const { data } = useQuery({
    queryKey: maintenanceQueryKey,
    queryFn: () => maintenanceApi.get(),
    refetchInterval: 30_000,
    retry: false,
  });
  return <MaintenanceBannerView status={data} companyId={companyId} />;
}
