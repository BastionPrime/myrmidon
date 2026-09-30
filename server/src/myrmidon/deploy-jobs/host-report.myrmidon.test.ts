// myrmidon(R5-A) deploy jobs: the host-report file channel.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostReportReader } from "./host-report.js";

const dirs: string[] = [];

function dir(): string {
  const created = mkdtempSync(join(tmpdir(), "deploy-jobs-report-"));
  dirs.push(created);
  return created;
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const JOB_ID = "11111111-2222-4333-8444-555555555555";

describe("host report reader", () => {
  it("returns null without a report and without a mounted directory", async () => {
    const read = hostReportReader(null);
    expect(await read(JOB_ID)).toBeNull();
    const readEmpty = hostReportReader(dir());
    expect(await readEmpty(JOB_ID)).toBeNull();
  });

  it("reads the report the deploy script wrote", async () => {
    const reports = dir();
    writeFileSync(
      join(reports, `job-${JOB_ID}.json`),
      JSON.stringify({ jobId: JOB_ID, phase: "health-ok", version: "1.2.1", commit: "0123456789abcdef0123456789abcdef01234567", at: "2026-09-30T08:00:00Z" }),
    );
    const report = await hostReportReader(reports)(JOB_ID);
    expect(report).toMatchObject({ jobId: JOB_ID, phase: "health-ok", version: "1.2.1" });
  });

  it("ignores a report of another job, an unknown phase and invalid JSON", async () => {
    const reports = dir();
    writeFileSync(join(reports, `job-${JOB_ID}.json`), JSON.stringify({ jobId: "other-job", phase: "health-ok" }));
    expect(await hostReportReader(reports)(JOB_ID)).toBeNull();

    writeFileSync(join(reports, `job-${JOB_ID}.json`), JSON.stringify({ jobId: JOB_ID, phase: "exploded" }));
    expect(await hostReportReader(reports)(JOB_ID)).toBeNull();

    writeFileSync(join(reports, `job-${JOB_ID}.json`), "{not json");
    expect(await hostReportReader(reports)(JOB_ID)).toBeNull();
  });

  it("refuses a jobId that is not a uuid (no path games)", async () => {
    const reports = dir();
    writeFileSync(join(reports, "job-..json"), JSON.stringify({ jobId: "..", phase: "claimed" }));
    expect(await hostReportReader(reports)("..")).toBeNull();
  });
});
