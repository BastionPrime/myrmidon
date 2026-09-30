// myrmidon(WORKSPACE-HYGIENE) part C: the production wiring, not a mock of it.
//
// The CI typecheck and build caught a wiring mistake the unit tests could not
// see: `createRuntime` handed the sweep the `{ limits, sources }` wrapper
// instead of the limits, so `limits.workspaceQuotaMb` was `undefined`, every
// quota comparison was `NaN > quota` and no quota ever signalled — while the
// sweep tests stayed green, because they inject their own `resolveLimits`.
// This file builds the sweep through the real helper from index.ts, so the
// same mistake turns it red again.

import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_QUOTA_EXCEEDED_ACTION, type WorkspaceHygieneLimits } from "@paperclipai/shared";
import { resolveSweepLimits } from "./index.js";
import { createWorkspaceHygieneSweep } from "./sweep.js";
import type { WorkspaceHygieneStore, WorkspaceHygieneWorkspaceRow } from "./store.js";
import type { WorkspaceSizeMeasurement } from "./measure.js";

const MB = 1024 * 1024;
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

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

function makeRow(overrides: Partial<WorkspaceHygieneWorkspaceRow> & { id: string }): WorkspaceHygieneWorkspaceRow {
  return {
    companyId: COMPANY_ID,
    name: `workspace-${overrides.id}`,
    status: "active",
    providerType: "local_fs",
    cwd: `/workspaces/${overrides.id}`,
    metadata: null,
    updatedAt: new Date("2026-09-30T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeStore(rows: WorkspaceHygieneWorkspaceRow[]): WorkspaceHygieneStore {
  const state = new Map(rows.map((row) => [row.id, { ...row }]));
  return {
    listPage: async ({ cursor, boundary, limit }) => {
      const candidates = [...state.values()]
        .filter((row) => row.updatedAt.getTime() <= boundary.getTime())
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
        .filter((row) =>
          cursor
            ? row.updatedAt.getTime() > cursor.updatedAt.getTime()
              || (row.updatedAt.getTime() === cursor.updatedAt.getTime() && row.id > cursor.id)
            : true,
        );
      return candidates.slice(0, limit);
    },
    listMeasured: async (limit) =>
      [...state.values()].filter((row) => row.metadata !== null).slice(0, limit),
    saveMetadata: async (workspaceId, metadata) => {
      const row = state.get(workspaceId);
      if (row) row.metadata = metadata;
    },
    lastActivityAt: async () => null,
  };
}

describe("myrmidon(WORKSPACE-HYGIENE): the limits the runtime resolves", () => {
  it("returns the limits, not the { limits, sources } wrapper the API reports", async () => {
    const settings = {
      getGeneral: async () => ({ workspaceHygiene: { workspaceQuotaMb: 4000, totalQuotaMb: 9000 } }),
    };
    const limits: WorkspaceHygieneLimits = await resolveSweepLimits(settings, {});
    expect(limits).toEqual({ workspaceQuotaMb: 4000, totalQuotaMb: 9000 });
    expect((limits as { sources?: unknown }).sources).toBeUndefined();
    expect(Object.keys(limits).sort()).toEqual(["totalQuotaMb", "workspaceQuotaMb"]);
  });

  it("falls back to the environment when the row holds nothing", async () => {
    const settings = { getGeneral: async () => ({}) };
    const limits = await resolveSweepLimits(settings, { MYRMIDON_WORKSPACE_QUOTA_MB: "2048" });
    expect(limits).toEqual({ workspaceQuotaMb: 2048, totalQuotaMb: null });
  });

  it("falls back to both quotas off when nothing is set", async () => {
    const settings = { getGeneral: async () => ({ workspaceHygiene: null }) };
    const limits = await resolveSweepLimits(settings, {});
    expect(limits).toEqual({ workspaceQuotaMb: null, totalQuotaMb: null });
  });
});

describe("myrmidon(WORKSPACE-HYGIENE): a sweep through the real wiring", () => {
  it("a stored quota that the workspace outgrows produces a signal", async () => {
    const settings = {
      getGeneral: async () => ({ workspaceHygiene: { workspaceQuotaMb: 4000, totalQuotaMb: null } }),
    };
    const row = makeRow({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const logActivity = vi.fn(async () => ({}));
    const sweep = createWorkspaceHygieneSweep({
      store: fakeStore([row]),
      resolveLimits: () => resolveSweepLimits(settings, {}),
      measure: async () => measurement(5000 * MB),
      logActivity,
      now: () => new Date("2026-09-30T12:00:00.000Z"),
    });

    const result = await sweep.sweep();

    // The regression guard: the wrapper mistake reads the quota as undefined
    // and this count drops to zero while every unit test stays green.
    expect(result.overQuota).toBe(1);
    expect(result.signalled).toBe(1);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0]![0]).toMatchObject({
      action: WORKSPACE_QUOTA_EXCEEDED_ACTION,
      entityType: "execution_workspace",
      entityId: row.id,
    });
    expect(logActivity.mock.calls[0]![0].details).toMatchObject({ sizeMb: 5000, quotaMb: 4000 });
  });

  it("a workspace inside the stored quota stays silent", async () => {
    const settings = {
      getGeneral: async () => ({ workspaceHygiene: { workspaceQuotaMb: 4000, totalQuotaMb: null } }),
    };
    const logActivity = vi.fn(async () => ({}));
    const sweep = createWorkspaceHygieneSweep({
      store: fakeStore([makeRow({ id: "bbbbbbbb-1111-4111-8111-111111111111" })]),
      resolveLimits: () => resolveSweepLimits(settings, {}),
      measure: async () => measurement(3999 * MB),
      logActivity,
      now: () => new Date("2026-09-30T12:00:00.000Z"),
    });

    const result = await sweep.sweep();

    expect(result.overQuota).toBe(0);
    expect(result.signalled).toBe(0);
    expect(logActivity).not.toHaveBeenCalled();
  });
});