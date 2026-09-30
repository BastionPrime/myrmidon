// myrmidon(R5-A) deploy jobs: the pure job-model rules.
//
// These tests pin the acceptance criterion "an image that is not from CI, or
// with a foreign fingerprint, is refused": every refusal case of deploy.sh's
// image check has a twin here that must fail the same way.

import { describe, expect, it } from "vitest";
import {
  DEPLOY_IMAGE_REPOSITORY,
  digestProblem,
  isAbortable,
  isDeployJobActive,
  isDeployJobDispatchable,
  newDeployJob,
  parseDigest,
  parseDeployJobDocument,
  retireJob,
  assertNoActiveJob,
  DeployJobConflict,
  appendStep,
  verifyCiImage,
} from "./domain.js";

const GOOD = `sha256:${"a".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const NOW = new Date("2026-09-30T08:00:00.000Z");

describe("deploy jobs: digest form", () => {
  it("accepts a bare digest and a full CI reference", () => {
    expect(digestProblem(GOOD)).toBeNull();
    expect(digestProblem(`${DEPLOY_IMAGE_REPOSITORY}@${GOOD}`)).toBeNull();
    expect(parseDigest(`${DEPLOY_IMAGE_REPOSITORY}@${GOOD}`)).toBe(GOOD);
    expect(parseDigest(GOOD)).toBe(GOOD);
  });

  it("refuses a tag, a foreign repository and a malformed digest the way the script does", () => {
    expect(digestProblem("1.0.0")).toMatch(/no digest|sha256/);
    expect(digestProblem("ghcr.io/other/myrmidon@sha256:" + "a".repeat(64))).toContain("is not");
    expect(digestProblem("sha256:ABC")).toContain("64 lowercase hex");
    expect(digestProblem("sha256:" + "a".repeat(63))).toContain("64 lowercase hex");
    expect(digestProblem("")).toContain("no image given");
  });
});

describe("deploy jobs: CI image verification", () => {
  const base = {
    reference: `${DEPLOY_IMAGE_REPOSITORY}@${GOOD}`,
    labels: {
      "org.opencontainers.image.revision": COMMIT,
      "org.opencontainers.image.source": SOURCE,
      "org.opencontainers.image.version": "1.2.1",
    },
    commitOnMain: () => true,
    releaseTagsAtCommit: null,
  };

  it("passes a CI image built from a commit on main", () => {
    const result = verifyCiImage(base);
    expect(result).toMatchObject({ ok: true, digest: GOOD, version: "1.2.1", commit: COMMIT });
  });

  it("passes an image from a myr-v* tag when the commit left main", () => {
    const result = verifyCiImage({ ...base, commitOnMain: () => false, releaseTagsAtCommit: ["myr-v1.2.1"] });
    expect(result.ok).toBe(true);
  });

  it("refuses an image the registry does not have", () => {
    const result = verifyCiImage({ ...base, labels: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cannot be read from the registry");
  });

  it("refuses an image without the CI revision label", () => {
    const result = verifyCiImage({
      ...base,
      labels: { "org.opencontainers.image.source": SOURCE, "org.opencontainers.image.version": "1.2.1" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("org.opencontainers.image.revision");
  });

  it("refuses an image with a foreign source label", () => {
    const result = verifyCiImage({
      ...base,
      labels: {
        "org.opencontainers.image.revision": COMMIT,
        "org.opencontainers.image.source": "https://github.com/someone_else/myrmidon",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("org.opencontainers.image.source");
  });

  it("refuses an image whose commit is neither on main nor released", () => {
    const result = verifyCiImage({ ...base, commitOnMain: () => false, releaseTagsAtCommit: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("neither on origin/main nor tagged myr-v*");
  });

  it("ignores tags that are not myr-v<semver>", () => {
    const result = verifyCiImage({ ...base, commitOnMain: () => false, releaseTagsAtCommit: ["v9.9.9", "myr-v1.2"] });
    expect(result.ok).toBe(false);
  });
});

describe("deploy jobs: document and lifecycle rules", () => {
  const job = (overrides: Partial<ReturnType<typeof newDeployJob>> = {}) => ({
    ...newDeployJob({ id: "job-a", companyId: "company-a", digest: GOOD, reason: "deploy", startedBy: { actorType: "user", actorId: "user-a" }, now: NOW }),
    ...overrides,
  });

  it("keeps at most one active job: a second create is a conflict", () => {
    const doc = { version: 1 as const, jobs: [job({ status: "running" })], history: [] };
    expect(() => assertNoActiveJob(doc)).toThrow(DeployJobConflict);
    const idle = { version: 1 as const, jobs: [job({ status: "succeeded" })], history: [] };
    expect(() => assertNoActiveJob(idle)).not.toThrow();
  });

  it("active and dispatchable statuses split the lifecycle", () => {
    expect(isDeployJobActive("pending")).toBe(true);
    expect(isDeployJobActive("running")).toBe(true);
    expect(isDeployJobActive("succeeded")).toBe(false);
    expect(isDeployJobActive("failed_health")).toBe(false);
    expect(isDeployJobDispatchable("maintenance_on")).toBe(true);
    expect(isDeployJobDispatchable("verified")).toBe(false);
  });

  it("a job is abortable only before the image switch", () => {
    expect(isAbortable(job({ status: "verified" }))).toBe(true);
    expect(isAbortable(job({ status: "maintenance_entering" }))).toBe(true);
    expect(isAbortable(job({ status: "running" }))).toBe(false);
    expect(isAbortable(job({ status: "maintenance_on" }))).toBe(false);
  });

  it("retireJob moves a finished job into bounded history", () => {
    const doc = { version: 1 as const, jobs: [job({ status: "succeeded" })], history: [] };
    const next = retireJob(doc, "job-a", NOW);
    expect(next.jobs).toHaveLength(0);
    expect(next.history[0].id).toBe("job-a");
  });

  it("appendStep bounds the step log", () => {
    let current = job();
    for (let i = 0; i < 150; i += 1) current = appendStep(current, "verifying", `step ${i}`, NOW);
    expect(current.steps.length).toBe(100);
    expect(current.steps[current.steps.length - 1].detail).toBe("step 149");
  });

  it("a malformed stored document reads as empty, never as a live job", () => {
    expect(parseDeployJobDocument(null).jobs).toHaveLength(0);
    expect(parseDeployJobDocument({ version: 1, jobs: [{ id: "x" }] }).jobs).toHaveLength(0);
    expect(parseDeployJobDocument({ version: 1, jobs: [{ id: "x", digest: GOOD, status: "running" }] }).jobs).toHaveLength(1);
    // unknown status drops out
    expect(parseDeployJobDocument({ version: 1, jobs: [{ id: "x", digest: GOOD, status: "exploded" }] }).jobs).toHaveLength(0);
  });
});
