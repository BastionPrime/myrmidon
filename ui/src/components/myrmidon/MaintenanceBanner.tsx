// Maintenance mode (R3) banner, shown in the common layout while a maintenance
// window concerns the current company. Informational only: changes happen in
// Instance settings → General → Maintenance.
//
// Agent-scoped windows are opened in batches (for example when bot container
// templates are updated), so windows of one kind are shown as a single line;
// windows that are already ending collapse into one compact line.
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

export interface AgentWindowGroup {
  key: string;
  reason: string;
  windows: MaintenanceWindowView[];
  queuedWakeups: number;
  runningRuns: number;
  drainTimedOut: boolean;
  startedAt: string;
}

export interface GroupedWindows {
  /** Instance, company and department windows: one line each, as before. */
  single: MaintenanceWindowView[];
  /** Agent windows that are on or draining, one entry per kind of reason. */
  agentGroups: AgentWindowGroup[];
  /** Agent windows already ending, shown together on one compact line. */
  ending: MaintenanceWindowView[];
}

export function groupWindows(windows: MaintenanceWindowView[]): GroupedWindows {
  const single: MaintenanceWindowView[] = [];
  const ending: MaintenanceWindowView[] = [];
  const groups = new Map<string, AgentWindowGroup>();
  for (const window of windows) {
    if (window.scope.type !== "agent") {
      single.push(window);
      continue;
    }
    if (window.state === "leaving") {
      ending.push(window);
      continue;
    }
    const reason = normalizeReason(window.reason);
    const key = `${window.state === "entering" ? "entering" : "on"}\u0000${reason}`;
    const group = groups.get(key) ?? {
      key,
      reason,
      windows: [],
      queuedWakeups: 0,
      runningRuns: 0,
      drainTimedOut: false,
      startedAt: window.startedAt,
    };
    group.windows.push(window);
    group.queuedWakeups += window.queuedWakeups;
    group.runningRuns += window.runningRuns;
    group.drainTimedOut ||= window.drainTimedOut;
    if (new Date(window.startedAt).getTime() < new Date(group.startedAt).getTime()) group.startedAt = window.startedAt;
    groups.set(key, group);
  }
  return { single, agentGroups: [...groups.values()], ending };
}

function agentIds(windows: MaintenanceWindowView[]): string {
  return windows.map((w) => w.scope.id ?? w.id).join(", ");
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

  const { single, agentGroups, ending } = groupWindows(windows);
  return (
    <div
      role="status"
      data-testid="myrmidon-maintenance-banner"
      className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex flex-col gap-1 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
          <Wrench className="h-3.5 w-3.5 shrink-0" />
          <span>{t("maintenanceBanner.title")}</span>
        </div>
        {single.map((window) => (
          <p key={window.id}>
            {t("maintenanceBanner.window", {
              scope: t(`maintenanceBanner.scope.${window.scope.type}`),
              state: stateLabel(window),
              since: new Date(window.startedAt).toLocaleString(),
              reason: window.reason,
              queued: window.queuedWakeups,
            })}
          </p>
        ))}
        {agentGroups.map((group) => (
          <details key={group.key} data-testid="myrmidon-maintenance-agent-group">
            <summary className="cursor-pointer" title={agentIds(group.windows)}>
              {t("maintenanceBanner.group", {
                state: stateLabel({
                  state: group.key.startsWith("entering") ? "entering" : "on",
                  runningRuns: group.runningRuns,
                  drainTimedOut: group.drainTimedOut,
                }),
                since: new Date(group.startedAt).toLocaleString(),
                reason: group.reason,
                count: group.windows.length,
                queued: group.queuedWakeups,
              })}
            </summary>
            <p className="pl-4 text-xs opacity-80">
              {t("maintenanceBanner.idsSummary")}: {agentIds(group.windows)}
            </p>
          </details>
        ))}
        {ending.length > 0 ? (
          <p data-testid="myrmidon-maintenance-ending" title={agentIds(ending)}>
            {t("maintenanceBanner.ending", { count: ending.length })}
          </p>
        ) : null}
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
