// Maintenance mode (R3) API: GET/POST /api/myrmidon/maintenance.
// Contract: docs/myrmidon/design/maintenance-mode.md §7.
import { api } from "@/api/client";

export type MaintenanceScopeType = "instance" | "company" | "department" | "agent";
export type MaintenanceOnTimeout = "wait" | "interrupt_and_retry";

export interface MaintenanceScope {
  type: MaintenanceScopeType;
  id?: string | null;
}

export interface MaintenanceWindowView {
  id: string;
  scope: MaintenanceScope;
  companyId: string | null;
  state: "entering" | "on" | "leaving";
  reason: string;
  drainTimeoutSec: number;
  onTimeout: MaintenanceOnTimeout;
  startedAt: string;
  onAt: string | null;
  drainDeadlineAt: string;
  drainTimedOut: boolean;
  exitRequestedAt: string | null;
  runningRuns: number;
  queuedRuns: number;
  queuedWakeups: number;
  interruptedRuns: number;
}

export interface MaintenanceStatus {
  active: boolean;
  instance: MaintenanceWindowView | null;
  windows: MaintenanceWindowView[];
}

export interface MaintenanceEnterInput {
  scope: MaintenanceScope;
  reason: string;
  drainTimeoutSec?: number;
  onTimeout?: MaintenanceOnTimeout;
}

export const maintenanceQueryKey = ["myrmidon", "maintenance"] as const;

export const maintenanceApi = {
  get: () => api.get<MaintenanceStatus>("/myrmidon/maintenance"),
  enter: (input: MaintenanceEnterInput) => api.post<unknown>("/myrmidon/maintenance", { action: "enter", ...input }),
  exit: (scope: MaintenanceScope) => api.post<unknown>("/myrmidon/maintenance", { action: "exit", scope }),
};

/** Windows that concern a company: instance-wide ones and the company's own. */
export function windowsForCompany(status: MaintenanceStatus | null | undefined, companyId: string | null) {
  if (!status?.active) return [];
  return status.windows.filter((w) => w.scope.type === "instance" || (companyId !== null && w.companyId === companyId));
}

export function describeScope(scope: MaintenanceScope): string {
  switch (scope.type) {
    case "instance":
      return "the whole instance";
    case "company":
      return "this company";
    case "department":
      return "a department";
    default:
      return "an agent";
  }
}
