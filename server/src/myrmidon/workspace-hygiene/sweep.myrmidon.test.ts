// myrmidon(WORKSPACE-HYGIENE) part C: the sweep around the disk walk.
//
// The sweep runs over a fake store and a fake measurement, so the rotation, the
// freshness window, the quota decision and the once-a-day signal are all
// provable without a database or a disk. The acceptance case of the ticket is
// the first one: an over-quota workspace is signalled once, not once a tick.

import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_QUOTA_EXCEEDED_ACTION,
  WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION,
  WORKSPACE_HYGIENE_METADATA_KEY,
  readWorkspaceHygieneRecord,
  type WorkspaceHygieneLimits,
} from "@paperclipai/shared";
import type { LogActivityInput } from "../../services/activity-log.js";
import { WORKSPACE_HYGIENE_ACTOR_ID, createWorkspaceHygieneSweep } from "./sweep.js";
import type { WorkspaceHygieneStore, WorkspaceHygieneWorkspaceRow } from "./store.js";
import type { WorkspaceSizeMeasurement } from "./measure.js";

const MB = 1024 * 1024;
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

interface FakeRow extends WorkspaceHygieneWorkspaceRow {}

function makeRow(overrides: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    companyId: COMPANY_ID,
    name: `workspace-${overrides.id}`,
    status: "active",
    providerType: "local_fs",
    cwd: `/workspaces/${overrides.id}`,
    metadata: null,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function measurement(sizeBytes: number): WorkspaceSizeMeasurement {
  return {
    sizeBytes,
    entries: 3,
    directories: 1,
    files: 2,
    truncated: false,
    depthCapped: false,
    elapsedMs: 1,
  };
}

function createFakeStore(rows: FakeRow[]) {
  const state = new Map(rows.map((row) => [row.id, { ...row }]));
  const writes: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const activity: Array<{ companyId: string; action: string; at: Date }> = [];

  const store: WorkspaceHygieneStore = {
    listPage: async ({ cursor, boundary, limit }) => {
      const candidates = [...state.values()]
        .filter((row) => row.updatedAt.getTime() <= boundary.getTime())
        .sort((a, b) =>
          a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id),
        )
        .filter((row) =>
          cursor
            ? row.updatedAt.getTime() > cursor.updatedAt.getTime()
              || (row.updatedAt.getTime() === cursor.updatedAt.getTime() && row.id > cursor.id)
            : true,
        );
      return candidates.slice(0, limit).map((row) => ({ ...row }));
    },
    listMeasured: async (limit) =>
      [...state.values()]
        .filter((row) => readWorkspaceHygieneRecord(row.metadata) !== null)
        .slice(0, limit)
        .map((row) => ({ ...row })),
    saveMetadata: async (workspaceId, metadata) => {
      const row = state.get(workspaceId);
      if (!row) throw new Error(`unknown workspace ${workspaceId}`);
      row.metadata = metadata;
      writes.push({ id: workspaceId, metadata });
    },
    lastActivityAt: async (companyId, action) => {
      const times = activity
        .filter((entry) => entry.companyId === companyId && entry.action === action)
        .map((entry) => entry.at.getTime());
      return times.length > 0 ? new Date(Math.max(...times)) : null;
    },
  };

  return { store, writes, activity, state };
}

function harness(options: {
  rows: FakeRow[];
  limits?: WorkspaceHygieneLimits;
  sizes?: Record<string, number>;
  now?: () => Date;
  pageSize?: number;
  remeasureIntervalMs?: number;
  maxSweepMs?: number;
}) {
  const { store, writes, activity, state } = createFakeStore(options.rows);
  const sizes = options.sizes ?? {};
  const measure = vi.fn(async (cwd: string) => {
    const key = cwd.split("/").pop()!;
    const size = sizes[key];
    if (size === undefined) throw new Error(`no measurement for ${key}`);
    return measurement(size);
  });
  const logActivity = vi.fn(async (entry: LogActivityInput) => {
    activity.push({
      companyId: entry.companyId,
      action: entry.action,
      at: options.now ? options.now() : new Date(),
    });
    return {};
  });
  const sweep = createWorkspaceHygieneSweep({
    store,
    resolveLimits: async () => options.limits ?? { workspaceQuotaMb: 4000, totalQuotaMb: null },
    measure,
    logActivity,
    now: options.now,
    pageSize: options.pageSize,
    remeasureIntervalMs: options.remeasureIntervalMs ?? 0,
    maxSweepMs: options.maxSweepMs,
  });
  return { sweep, measure, logActivity, writes, activity, state };
}

function quotaSignals(activity: Array<{ action: string }>): number {
  return activity.filter((entry) => entry.action === WORKSPACE_QUOTA_EXCEEDED_ACTION).length;
}

describe("myrmidon(WORKSPACE-HYGIENE): the quota sweep", () => {
  it("signals an over-quota workspace once a day, not once a tick", async () => {
    const start = new Date("2026-09-30T12:00:00.000Z");
    let now = start;
    const { sweep, activity } = harness({
      rows: [makeRow({ id: "aaaaaaaa-1111-4111-8111-111111111111" })],
      sizes: { "aaaaaaaa-1111-4111-8111-111111111111": 5000 * MB },
      now: () => now,
    });

    const first = await sweep.sweep();
    expect(first.measured).toBe(1);
    expect(first.overQuota).toBe(1);
    expect(first.signalled).toBe(1);
    expect(quotaSignals(activity)).toBe(1);

    now = new Date(start.getTime() + 60 * 60 * 1000);
    const second = await sweep.sweep();
    expect(second.measured).toBe(1);
    expect(second.overQuota).toBe(1);
    expect(second.signalled).toBe(0);
    expect(quotaSignals(activity)).toBe(1);

    now = new Date(start.getTime() + 25 * 60 * 60 * 1000);
    const third = await sweep.sweep();
    expect(third.signalled).toBe(1);
    expect(quotaSignals(activity)).toBe(2);
  });

  it("writes the measurement into the workspace metadata and keeps other keys", async () => {
    const { sweep, writes } = harness({
      rows: [
        makeRow({
          id: "bbbbbbbb-1111-4111-8111-111111111111",
          metadata: { lifecycleGeneration: 7 },
        }),
      ],
      sizes: { "bbbbbbbb-1111-4111-8111-111111111111": 100 * MB },
    });

    await sweep.sweep();

    expect(writes).toHaveLength(1);
    const metadata = writes[0]!.metadata;
    expect(metadata.lifecycleGeneration).toBe(7);
    expect(readWorkspaceHygieneRecord(metadata)).toMatchObject({
      sizeBytes: 100 * MB,
      overQuota: false,
      truncated: false,
      lastSignalAt: null,
    });
  });

  it("says nothing about a workspace inside its quota", async () => {
    const { sweep, activity, writes } = harness({
      rows: [makeRow({ id: "cccccccc-1111-4111-8111-111111111111" })],
      sizes: { "cccccccc-1111-4111-8111-111111111111": 4000 * MB },
    });

    const result = await sweep.sweep();

    expect(result.overQuota).toBe(0);
    expect(result.signalled).toBe(0);
    expect(activity).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  it("ranks every signal with the sweep as its author and no host path", async () => {
    const { sweep, logActivity } = harness({
      rows: [makeRow({ id: "dddddddd-1111-4111-8111-111111111111", cwd: "/workspaces/quota-test/wt" })],
      sizes: { wt: 6000 * MB },
    });

    await sweep.sweep();

    const entry = logActivity.mock.calls[0]![0];
    expect(entry.actorType).toBe("system");
    expect(entry.actorId).toBe(WORKSPACE_HYGIENE_ACTOR_ID);
    expect(entry.action).toBe(WORKSPACE_QUOTA_EXCEEDED_ACTION);
    expect(entry.entityType).toBe("execution_workspace");
    expect(entry.entityId).toBe("dddddddd-1111-4111-8111-111111111111");
    expect(entry.details).toMatchObject({ sizeMb: 6000, quotaMb: 4000 });
    expect(JSON.stringify(entry.details)).not.toContain("/workspaces");
  });

  it("skips a fresh measurement instead of walking the disk again", async () => {
    const start = new Date("2026-09-30T12:00:00.000Z");
    let now = start;
    const { sweep, measure } = harness({
      rows: [makeRow({ id: "eeeeeeee-1111-4111-8111-111111111111" })],
      sizes: { "eeeeeeee-1111-4111-8111-111111111111": 10 * MB },
      now: () => now,
      remeasureIntervalMs: 6 * 60 * 60 * 1000,
    });

    await sweep.sweep();
    now = new Date(start.getTime() + 60 * 60 * 1000);
    const second = await sweep.sweep();

    expect(measure).toHaveBeenCalledTimes(1);
    expect(second.skippedFresh).toBe(1);
    expect(second.measured).toBe(0);
  });

  it("skips a workspace with nothing local to measure", async () => {
    const { sweep, writes, measure } = harness({
      rows: [
        makeRow({ id: "ffffffff-1111-4111-8111-111111111111", cwd: null }),
        makeRow({ id: "11111111-2222-4222-8222-222222222222", providerType: "kubernetes" }),
      ],
      sizes: {},
    });

    const result = await sweep.sweep();

    expect(result.skippedUnmeasurable).toBe(2);
    expect(result.measured).toBe(0);
    expect(measure).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("keeps sweeping when one measurement fails", async () => {
    const { sweep, activity } = harness({
      rows: [
        makeRow({ id: "22222222-2222-4222-8222-222222222222" }),
        makeRow({ id: "33333333-2222-4222-8222-222222222222" }),
      ],
      // Only the second workspace has a size, so the first measurement throws.
      sizes: { "33333333-2222-4222-8222-222222222222": 9000 * MB },
    });

    const result = await sweep.sweep();

    expect(result.failed).toBe(1);
    expect(result.measured).toBe(1);
    expect(result.signalled).toBe(1);
    expect(quotaSignals(activity)).toBe(1);
  });

  it("rotates through the workspaces instead of measuring the same page every tick", async () => {
    const { sweep, measure } = harness({
      rows: [
        makeRow({ id: "44444444-2222-4222-8222-222222222222", updatedAt: new Date("2026-09-01T00:00:00.000Z") }),
        makeRow({ id: "55555555-2222-4222-8222-222222222222", updatedAt: new Date("2026-09-02T00:00:00.000Z") }),
        makeRow({ id: "66666666-2222-4222-8222-222222222222", updatedAt: new Date("2026-09-03T00:00:00.000Z") }),
      ],
      sizes: {
        "44444444-2222-4222-8222-222222222222": 10 * MB,
        "55555555-2222-4222-8222-222222222222": 10 * MB,
        "66666666-2222-4222-8222-222222222222": 10 * MB,
      },
      pageSize: 2,
    });

    const first = await sweep.sweep();
    const second = await sweep.sweep();

    expect(first.scanned).toBe(2);
    expect(second.scanned).toBe(1);
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("gives up at the sweep time budget and leaves the rest for the next tick", async () => {
    let tick = 0;
    const { sweep, measure } = harness({
      rows: [
        makeRow({ id: "77777777-2222-4222-8222-222222222222" }),
        makeRow({ id: "88888888-2222-4222-8222-222222222222" }),
        makeRow({ id: "99999999-2222-4222-8222-222222222222" }),
      ],
      sizes: {
        "77777777-2222-4222-8222-222222222222": 10 * MB,
        "88888888-2222-4222-8222-222222222222": 10 * MB,
        "99999999-2222-4222-8222-222222222222": 10 * MB,
      },
      // Every clock read advances 400 ms. The sweep starts at the first read and
      // checks its budget at the top of each row: the first row starts at 800 ms
      // (inside the 900 ms budget), the second at 1200 ms (past it). The base is
      // after the rows, so the rotation boundary does not filter them out.
      now: () => new Date(Date.parse("2026-09-30T12:00:00.000Z") + (tick += 400)),
      maxSweepMs: 900,
      pageSize: 3,
    });

    const result = await sweep.sweep();

    expect(result.measured).toBe(1);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("signals the company total once per window when the sum crosses its ceiling", async () => {
    const start = new Date("2026-09-30T12:00:00.000Z");
    let now = start;
    const { sweep, activity } = harness({
      limits: { workspaceQuotaMb: null, totalQuotaMb: 2000 },
      rows: [
        makeRow({ id: "aaaa1111-2222-4222-8222-222222222222" }),
        makeRow({ id: "bbbb2222-2222-4222-8222-222222222222" }),
      ],
      sizes: {
        "aaaa1111-2222-4222-8222-222222222222": 1200 * MB,
        "bbbb2222-2222-4222-8222-222222222222": 1500 * MB,
      },
      now: () => now,
    });

    const first = await sweep.sweep();
    expect(first.totalSignalled).toBe(true);
    expect(
      activity.filter((entry) => entry.action === WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION),
    ).toHaveLength(1);
    // No per-workspace quota is set, so nothing signals per workspace.
    expect(quotaSignals(activity)).toBe(0);

    now = new Date(start.getTime() + 60 * 60 * 1000);
    const second = await sweep.sweep();
    expect(second.totalSignalled).toBe(false);
    expect(
      activity.filter((entry) => entry.action === WORKSPACE_TOTAL_QUOTA_EXCEEDED_ACTION),
    ).toHaveLength(1);

    now = new Date(start.getTime() + 25 * 60 * 60 * 1000);
    const third = await sweep.sweep();
    expect(third.totalSignalled).toBe(true);
  });

  it("says nothing about the total when no total ceiling is set", async () => {
    const { sweep, activity } = harness({
      limits: { workspaceQuotaMb: null, totalQuotaMb: null },
      rows: [makeRow({ id: "cccc3333-2222-4222-8222-222222222222" })],
      sizes: { "cccc3333-2222-4222-8222-222222222222": 9000 * MB },
    });

    const result = await sweep.sweep();

    expect(result.totalSignalled).toBe(false);
    expect(activity).toHaveLength(0);
  });

  it("keeps one sweep in flight when two ticks overlap", async () => {
    const { sweep, measure } = harness({
      rows: [makeRow({ id: "dddd4444-2222-4222-8222-222222222222" })],
      sizes: { "dddd4444-2222-4222-8222-222222222222": 10 * MB },
    });

    const [first, second] = await Promise.all([sweep.sweep(), sweep.sweep()]);

    expect(measure).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(sweep.lastResult()).toEqual(first);
  });
});