// Board self-deploy (myrmidon R5-A): the host-report channel.
//
// deploy.sh --from-job (the new mode of scripts/myrmidon/deploy) writes a
// small JSON report next to its state directory: $STATE_DIR/job-<id>.json.
// The board container cannot read the host filesystem — the deployment mounts
// the reports directory read-only at MYRMIDON_DEPLOY_REPORTS_DIR (the same
// directory the scripts write to), and this module reads the file from there.
// No exec, no docker socket: the channel is one JSON file per job, host →
// board only. The board never writes into it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostReport } from "./service.js";

export interface HostReportReader {
  (jobId: string): Promise<HostReport | null>;
}

const PHASES = new Set(["claimed", "switching", "switched", "health-ok", "health-failed", "error"]);

function parseReport(raw: unknown, jobId: string): HostReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.jobId !== jobId) return null;
  if (typeof record.phase !== "string" || !PHASES.has(record.phase)) return null;
  return {
    jobId,
    phase: record.phase as HostReport["phase"],
    version: typeof record.version === "string" ? record.version : null,
    commit: typeof record.commit === "string" ? record.commit : null,
    detail: typeof record.detail === "string" ? record.detail : null,
    at: typeof record.at === "string" ? record.at : undefined,
  };
}

/** Read the report of one job from the mounted reports directory. */
export function hostReportReader(reportsDir: string | null): HostReportReader {
  return async (jobId) => {
    if (!reportsDir || !/^[0-9a-f-]{36}$/.test(jobId)) return null;
    let raw: string;
    try {
      raw = readFileSync(join(reportsDir, `job-${jobId}.json`), "utf8");
    } catch {
      return null; // no report yet (or unreadable): the host has not got there
    }
    try {
      return parseReport(JSON.parse(raw), jobId);
    } catch {
      return null;
    }
  };
}
