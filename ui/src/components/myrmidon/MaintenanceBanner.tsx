// Maintenance mode (R3) banner, shown in the common layout while a maintenance
// window concerns the current company. Informational only: changes happen in
// Instance settings → General → Maintenance.
import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import {
  describeScope,
  maintenanceApi,
  maintenanceQueryKey,
  windowsForCompany,
  type MaintenanceStatus,
  type MaintenanceWindowView,
} from "./maintenanceApi";

function stateLabel(window: MaintenanceWindowView): string {
  if (window.state === "entering") {
    const runs = `${window.runningRuns} run${window.runningRuns === 1 ? "" : "s"}`;
    return window.drainTimedOut ? `draining, ${runs} past the timeout` : `draining, ${runs} still running`;
  }
  if (window.state === "leaving") return "ending";
  return "on";
}

export function MaintenanceBannerView({
  status,
  companyId,
}: {
  status: MaintenanceStatus | null | undefined;
  companyId: string | null;
}) {
  const windows = windowsForCompany(status, companyId);
  if (windows.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="myrmidon-maintenance-banner"
      className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex flex-col gap-1 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
          <Wrench className="h-3.5 w-3.5 shrink-0" />
          <span>Maintenance mode</span>
        </div>
        {windows.map((window) => (
          <p key={window.id}>
            Maintenance for {describeScope(window.scope)} ({stateLabel(window)}) since{" "}
            {new Date(window.startedAt).toLocaleString()}: {window.reason}. New agent runs are paused; wakes are
            queued ({window.queuedWakeups}) and will be delivered when maintenance ends.
          </p>
        ))}
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
