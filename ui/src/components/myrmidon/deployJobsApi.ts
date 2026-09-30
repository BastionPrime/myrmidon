// Board self-deploy (myrmidon R5-A): GET/POST /api/myrmidon/deploy-jobs.
//
// The screen lives in the instance settings; the API client mirrors the
// routes: read the live (or last) job, verify a digest without starting
// anything, start a deploy, abort one.
import { api } from "@/api/client";

export type DeployJobStatus =
  | "pending"
  | "verifying"
  | "verified"
  | "failed_verification"
  | "maintenance_entering"
  | "maintenance_on"
  | "maintenance_failed"
  | "running"
  | "succeeded"
  | "failed_health"
  | "aborted";

export interface DeployJobStep {
  at: string;
  status: DeployJobStatus;
  detail: string;
}

export interface DeployJobView {
  id: string;
  digest: string;
  version: string | null;
  commit: string | null;
  status: DeployJobStatus;
  reason: string;
  startedBy: { actorType: string; actorId: string };
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  healthVersion: string | null;
  healthCommit: string | null;
  failureReason: string | null;
  steps: DeployJobStep[];
  active: boolean;
  abortable: boolean;
}

export interface DeployJobState {
  job: DeployJobView | null;
  history: DeployJobView[];
}

export interface DeployImagePreview {
  ok: boolean;
  digest: string | null;
  version: string | null;
  commit: string | null;
  reason: string | null;
}

export const deployJobsQueryKey = ["myrmidon", "deploy-jobs"] as const;

export const deployJobsApi = {
  get: () => api.get<DeployJobState>("/myrmidon/deploy-jobs"),
  preview: (reference: string) =>
    api.post<DeployImagePreview>("/myrmidon/deploy-jobs/preview", { reference }),
  create: (reference: string, reason?: string) =>
    api.post<DeployJobView>("/myrmidon/deploy-jobs", { reference, ...(reason ? { reason } : {}) }),
  abort: (id: string) => api.post<DeployJobView>(`/myrmidon/deploy-jobs/${id}/abort`, { id }),
};

/** Client-side form of the digest rule, so the field can argue before the request. */
export function digestProblemClient(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "Enter the digest of an image built by CI: sha256:<64 hex>";
  if (trimmed.includes("@") && !trimmed.startsWith("ghcr.io/itkadr-git/myrmidon@")) {
    return "Only images from ghcr.io/itkadr-git/myrmidon are deployed";
  }
  if (!trimmed.includes("@") && !trimmed.startsWith("sha256:")) {
    return "A tag or a name cannot prove the image passed CI; use the digest sha256:<64 hex> from the CI run summary";
  }
  if (trimmed.includes(":") && !trimmed.includes("@") && !trimmed.startsWith("sha256:")) {
    return "A tag cannot prove the image passed CI; use the digest sha256:<64 hex> from the CI run summary";
  }
  const digest = trimmed.includes("@") ? trimmed.slice(trimmed.lastIndexOf("@") + 1) : trimmed;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return "The digest is sha256: followed by 64 lowercase hex characters";
  }
  return null;
}

export function describeDeployStatus(status: DeployJobStatus): string {
  switch (status) {
    case "pending":
    case "verifying":
    case "verified":
      return "Verifying the image";
    case "failed_verification":
      return "Image refused";
    case "maintenance_entering":
      return "Waiting for the maintenance window to drain";
    case "maintenance_on":
      return "Maintenance on, waiting for the host executor";
    case "maintenance_failed":
      return "Maintenance window failed";
    case "running":
      return "Switching the image";
    case "succeeded":
      return "Deployed";
    case "failed_health":
      return "Health check failed";
    case "aborted":
      return "Aborted";
    default:
      return status;
  }
}
