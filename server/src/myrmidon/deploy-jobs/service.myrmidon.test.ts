// myrmidon(R5-A) deploy jobs: the service lifecycle over fake ports.
//
// Pins the maintenance contract of the interface deploy: the window opens only
// after the image passed verification, the switch waits for `on`, health is
// confirmed against /api/health facts, and a failed health check keeps the
// window open for the rollback.

import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { emptyDeployJobDocument, type DeployJobDocument } from "./domain.js";
import { deployJobsService, type DeployJobServiceDeps, type HostReport } from "./service.js";
import { readDeployJobsSettings, type DeployJobsSettings } from "./settings.js";
import type { ProbeDeps } from "./registry.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const CI_LABELS = {
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": "https://github.com/itkadr-git/myrmidon",
  "org.opencontainers.image.version": VERSION,
};

const SETTINGS: DeployJobsSettings = { ...readDeployJobsSettings({}), enabled: true, tickMs: 60_000 };

function probes(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    fetchJson: async () => {
      throw new Error("network disabled in tests");
    },
    registryInspectUrl: "https://registry-inspect.example.com/inspect",
    ...overrides,
  };
}

/** In-memory document store standing in for the instance_settings row. */
class MemoryStore {
  doc: DeployJobDocument = emptyDeployJobDocument();

  read = async () => structuredClone(this.doc);
  mutate = async <T>(change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T }) => {
    const { next, result } = change(this.doc);
    if (next) this.doc = next;
    return { doc: this.doc, result, changed: next !== null };
  };
}

interface Harness {
  service: ReturnType<typeof deployJobsService>;
  store: MemoryStore;
  maintenance: {
    enter: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
  reports: Map<string, HostReport>;
  setHealth(value: { version: string | null; commit: string | null } | null): void;
  setWindow(value: { instance: { id: string; state: string } | null }): void;
}

function harness(options: {
  labels?: Record<string, string> | null;
  onMain?: boolean;
  enabled?: boolean;
} = {}): Harness {
  const store = new MemoryStore();
  const enter = vi.fn(async () => ({ id: "window-a", state: "entering" }));
  const exit = vi.fn(async () => ({ state: "off" }));
  let windowState: { instance: { id: string; state: string } | null } = { instance: { id: "window-a", state: "entering" } };
  const status = vi.fn(async () => windowState);
  const reports = new Map<string, HostReport>();
  let health: { version: string | null; commit: string | null } | null = null;

  const inspectAnswer =
    options.labels === undefined || options.labels === null
      ? options.labels === null
        ? null
        : { config: { Labels: CI_LABELS } }
      : { config: { Labels: options.labels } };

  const deps: DeployJobServiceDeps = {
    maintenance: {
      enter: enter as unknown as DeployJobServiceDeps["maintenance"]["enter"],
      exit: exit as unknown as DeployJobServiceDeps["maintenance"]["exit"],
      status: status as unknown as DeployJobServiceDeps["maintenance"]["status"],
    },
    readHostReport: async (jobId) => reports.get(jobId) ?? null,
    readHealth: async () => health,
    now: () => new Date("2026-09-30T08:00:00.000Z"),
    settings: { ...SETTINGS, enabled: options.enabled ?? true },
    probes: probes({
      fetchJson: async (url: string) => {
        if (url.startsWith("https://registry-inspect.example.com/")) return inspectAnswer;
        if (url.includes("/compare/")) return { status: options.onMain === false ? "diverged" : "ahead" };
        if (url.includes("matching-refs")) return [];
        throw new Error(`unexpected url ${url}`);
      },
    }),
    logActivity: (async () => ({})) as unknown as DeployJobServiceDeps["logActivity"],
  };

  const service = deployJobsService(store as unknown as Db, deps);
  return {
    service,
    store,
    maintenance: { enter, exit, status },
    reports,
    setHealth(value: { version: string | null; commit: string | null } | null) {
      health = value;
    },
    setWindow(value: { instance: { id: string; state: string } | null }) {
      windowState = value;
    },
  };
}

const ACTOR = { actorType: "user", actorId: "user-a" };

describe("deploy jobs service: creating a job", () => {
  it("refuses to start when the feature is not enabled", async () => {
    const h = harness({ enabled: false });
    await expect(h.service.create({ reference: GOOD }, ACTOR)).rejects.toThrow(/not enabled/);
  });

  it("refuses a non-CI image before anything happens: no window, no job left behind", async () => {
    const h = harness({ labels: null });
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("failed_verification");
    expect(job.failureReason).toContain("cannot be read from the registry");
    expect(h.maintenance.enter).not.toHaveBeenCalled();
    const current = await h.service.current();
    expect(current.job?.status).toBe("failed_verification");
  });

  it("refuses an image whose commit is not on main and not released", async () => {
    const h = harness({ onMain: false });
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("failed_verification");
    expect(job.failureReason).toContain("neither on origin/main nor tagged");
  });

  it("verifies a CI image and opens the maintenance window", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("maintenance_entering");
    expect(job.version).toBe(VERSION);
    expect(job.commit).toBe(COMMIT);
    expect(h.maintenance.enter).toHaveBeenCalledTimes(1);
    const call = h.maintenance.enter.mock.calls[0][0] as { reason: string };
    expect(call.reason).toContain("deploy ghcr.io/itkadr-git/myrmidon@sha256:b");
  });

  it("rejects a second job while one is active", async () => {
    const h = harness();
    await h.service.create({ reference: GOOD }, ACTOR);
    await expect(h.service.create({ reference: `sha256:${"c".repeat(64)}` }, ACTOR)).rejects.toThrow(/already in progress/);
  });
});

describe("deploy jobs service: the tick drives the job", () => {
  it("waits for the window to be on, then follows the host report", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    h.setWindow({ instance: { id: "window-a", state: "entering" } });
    await h.service.tick();
    expect((await h.service.current()).job?.status).toBe("maintenance_entering");

    h.setWindow({ instance: { id: "window-a", state: "on" } });
    await h.service.tick();
    let current = await h.service.current();
    expect(current.job?.status).toBe("maintenance_on");

    // No report yet: the job stays maintenance_on.
    await h.service.tick();
    expect((await h.service.current()).job?.status).toBe("maintenance_on");

    h.reports.set(job.id, { jobId: job.id, phase: "claimed" });
    await h.service.tick();
    current = await h.service.current();
    expect(current.job?.status).toBe("running");
  });

  it("succeeds when the host reports health-ok and /api/health agrees, then leaves maintenance", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    h.setWindow({ instance: { id: "window-a", state: "on" } });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "claimed" });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "health-ok", version: VERSION, commit: COMMIT });
    h.setHealth({ version: VERSION, commit: COMMIT });
    await h.service.tick();

    const current = await h.service.current();
    expect(current.job?.status).toBe("succeeded");
    expect(current.job?.healthVersion).toBe(VERSION);
    expect(h.maintenance.exit).toHaveBeenCalled();
  });

  it("fails the job when the host reports health-failed, and keeps the window for the rollback", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    h.setWindow({ instance: { id: "window-a", state: "on" } });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "claimed" });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "health-failed", detail: "health did not match" });
    await h.service.tick();

    const current = await h.service.current();
    expect(current.job?.status).toBe("failed_health");
    expect(current.job?.failureReason).toContain("health-failed");
    expect(h.maintenance.exit).not.toHaveBeenCalled();
  });

  it("does not trust health-ok alone: the board's own health must agree", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    h.setWindow({ instance: { id: "window-a", state: "on" } });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "claimed" });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "health-ok", version: VERSION, commit: COMMIT });
    h.setHealth({ version: "9.9.9", commit: "0000000000000000000000000000000000000000" });
    await h.service.tick();

    const current = await h.service.current();
    expect(current.job?.status).toBe("failed_health");
    expect(current.job?.failureReason).toContain("disagrees");
  });

  it("aborts a job that has not switched yet and leaves the window", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR); // maintenance_entering
    const aborted = await h.service.abort(job.id, ACTOR);
    expect(aborted.status).toBe("aborted");
    expect(h.maintenance.exit).toHaveBeenCalled();
  });

  it("refuses to abort a job whose switch already started", async () => {
    const h = harness();
    const job = await h.service.create({ reference: GOOD }, ACTOR);
    h.setWindow({ instance: { id: "window-a", state: "on" } });
    await h.service.tick();
    h.reports.set(job.id, { jobId: job.id, phase: "claimed" });
    await h.service.tick();
    await expect(h.service.abort(job.id, ACTOR)).rejects.toThrow(/cannot be aborted/);
  });

  it("aborts a step stuck past the timeout", async () => {
    const h = harness();
    const created = await h.service.create({ reference: GOOD }, ACTOR);
    expect(created.status).toBe("maintenance_entering");
    // Simulate the stall by moving the clock: the harness now() is fixed, so
    // drive the timeout through a service built with a moving clock instead.
    const store = new MemoryStore();
    let clock = new Date("2026-09-30T08:00:00.000Z").getTime();
    const deps: DeployJobServiceDeps = {
      maintenance: {
        enter: async () => ({ id: "window-b", state: "entering" }),
        exit: async () => ({ state: "off" }),
        status: async () => ({ instance: { id: "window-b", state: "entering" } }),
      },
      readHostReport: async () => null,
      readHealth: async () => null,
      now: () => new Date(clock),
      settings: { ...SETTINGS, stepTimeoutMs: 1000 },
      probes: probes({
        fetchJson: async (url: string) => {
          if (url.startsWith("https://registry-inspect.example.com/")) return { config: { Labels: CI_LABELS } };
          if (url.includes("/compare/")) return { status: "ahead" };
          return [];
        },
      }),
      logActivity: (async () => ({})) as unknown as DeployJobServiceDeps["logActivity"],
    };
    void store;
    const service = deployJobsService(store as unknown as Db, deps);
    const job = await service.create({ reference: GOOD }, ACTOR);
    expect(job.status).toBe("maintenance_entering");
    clock += 5000;
    await service.tick();
    const current = await service.current();
    expect(current.job?.status).toBe("aborted");
    expect(current.job?.failureReason).toContain("exceeded the timeout");
  });
});

describe("deploy jobs service: preview", () => {
  it("verifies a reference without creating a job", async () => {
    const h = harness();
    const preview = await h.service.preview(GOOD);
    expect(preview.ok).toBe(true);
    expect(preview.digest).toBe(GOOD);
    const current = await h.service.current();
    expect(current.job).toBeNull();
  });

  it("refuses a malformed reference in preview", async () => {
    const h = harness();
    await expect(h.service.preview("latest")).rejects.toThrow(/sha256/);
  });
});
