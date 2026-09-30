// myrmidon(WORKSPACE-HYGIENE) part C: the quota routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, workspace rows), so validation, permissions, the audit records and the
// reported sizes are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  WORKSPACE_HYGIENE_METADATA_KEY,
  WORKSPACE_HYGIENE_UPDATED_ACTION,
  type WorkspaceHygieneLimits,
} from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { workspaceHygieneRoutes } from "./routes.js";
import { workspaceHygieneService, type WorkspaceHygieneServiceDeps } from "./service.js";
import type { WorkspaceHygieneStore, WorkspaceHygieneWorkspaceRow } from "./store.js";
import type { WorkspaceHygieneSweepResult } from "./sweep.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const MB = 1024 * 1024;

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [] };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

const ENV_ONLY = { MYRMIDON_WORKSPACE_QUOTA_MB: "2048" };

function measuredRow(
  id: string,
  name: string,
  sizeBytes: number,
  overrides: Partial<WorkspaceHygieneWorkspaceRow> = {},
): WorkspaceHygieneWorkspaceRow {
  return {
    id,
    companyId: COMPANY_ID,
    name,
    status: "active",
    providerType: "local_fs",
    cwd: `/workspaces/${name}`,
    metadata: {
      [WORKSPACE_HYGIENE_METADATA_KEY]: {
        measuredAt: "2026-09-30T12:00:00.000Z",
        sizeBytes,
        entries: 10,
        truncated: false,
        overQuota: sizeBytes > 2048 * MB,
        lastSignalAt: null,
      },
    },
    updatedAt: new Date("2026-09-30T12:00:00.000Z"),
    ...overrides,
  };
}

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  companyIds?: string[];
  rows?: WorkspaceHygieneWorkspaceRow[];
  settingsError?: Error;
  lastSweep?: WorkspaceHygieneSweepResult | null;
}

function harness(options: HarnessOptions = {}) {
  const updated: Array<{ workspaceHygiene: WorkspaceHygieneLimits }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as unknown };

  const store: WorkspaceHygieneStore = {
    listPage: async () => [],
    listMeasured: async (limit) => (options.rows ?? []).slice(0, limit),
    saveMetadata: async () => undefined,
    lastActivityAt: async () => null,
  };

  const deps: WorkspaceHygieneServiceDeps = {
    settings: {
      getGeneral: async () => {
        if (options.settingsError) throw options.settingsError;
        return { workspaceHygiene: current.stored };
      },
      updateGeneral: async (patch) => {
        current.stored = patch.workspaceHygiene;
        updated.push(patch);
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
      return {};
    },
    store,
    lastSweep: () => options.lastSweep ?? null,
    env: options.env ?? ENV_ONLY,
  };

  const service = workspaceHygieneService(deps);
  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", workspaceHygieneRoutes({} as Db, service));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, updated, audits, deps, service };
}

const URL = "/api/myrmidon/workspace-hygiene";

describe("myrmidon(WORKSPACE-HYGIENE): reading the quotas and the measured sizes", () => {
  it("reports the environment value as the source when settings never saved one", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body.quota).toEqual({
      workspaceQuotaMb: 2048,
      totalQuotaMb: null,
      sources: { workspaceQuotaMb: "env", totalQuotaMb: "default" },
    });
    expect(res.body.workspaces).toEqual([]);
    expect(res.body.status).toMatchObject({
      measuredWorkspaces: 0,
      overQuotaCount: 0,
      totalSizeMb: 0,
      lastSweepAt: null,
      lastSweep: null,
    });
  });

  it("reports the stored value as the source once it exists", async () => {
    const { app } = harness({ stored: { workspaceQuotaMb: 5000, totalQuotaMb: 20000 } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.quota).toEqual({
      workspaceQuotaMb: 5000,
      totalQuotaMb: 20000,
      sources: { workspaceQuotaMb: "settings", totalQuotaMb: "settings" },
    });
  });

  it("falls back to the environment when the stored row is not canonical", async () => {
    const { app } = harness({ stored: { workspaceQuotaMb: 0, totalQuotaMb: null } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.quota.workspaceQuotaMb).toBe(2048);
    expect(res.body.quota.sources.workspaceQuotaMb).toBe("env");
  });

  it("lists the measured workspaces biggest first and sums them", async () => {
    const { app } = harness({
      rows: [
        measuredRow("aaaaaaaa-1111-4111-8111-111111111111", "small", 100 * MB),
        measuredRow("bbbbbbbb-1111-4111-8111-111111111111", "huge", 4096 * MB, {
          metadata: {
            [WORKSPACE_HYGIENE_METADATA_KEY]: {
              measuredAt: "2026-09-30T12:00:00.000Z",
              sizeBytes: 4096 * MB,
              entries: 90_000,
              truncated: true,
              overQuota: true,
              lastSignalAt: "2026-09-30T12:00:00.000Z",
            },
          },
        }),
        // A row the sweep never measured is not part of the list.
        measuredRow("cccccccc-1111-4111-8111-111111111111", "unmeasured", 0, { metadata: {} }),
      ],
      lastSweep: {
        at: "2026-09-30T12:00:00.000Z",
        scanned: 25,
        measured: 2,
        skippedFresh: 0,
        skippedUnmeasurable: 0,
        failed: 0,
        overQuota: 1,
        signalled: 1,
        totalBytes: 4196 * MB,
        totalSignalled: false,
        truncated: 1,
        elapsedMs: 120,
      },
    });

    const res = await request(app).get(URL).expect(200);

    expect(res.body.workspaces.map((workspace: { name: string }) => workspace.name)).toEqual([
      "huge",
      "small",
    ]);
    expect(res.body.workspaces[0]).toMatchObject({
      sizeMb: 4096,
      overQuota: true,
      truncated: true,
      status: "active",
    });
    expect(res.body.status).toMatchObject({
      measuredWorkspaces: 2,
      overQuotaCount: 1,
      totalSizeMb: 4196,
      lastSweepAt: "2026-09-30T12:00:00.000Z",
    });
    expect(res.body.status.lastSweep.measured).toBe(2);
  });

  it("refuses agents and board members without organization access", async () => {
    const h = harness();
    await request(h.withActor(agentActor)).get(URL).expect(403);
    await request(h.withActor(outsider)).get(URL).expect(403);
  });

  it("answers 500 instead of hiding a database failure", async () => {
    const h = harness({ settingsError: new Error("database is down") });
    await request(h.app).get(URL).expect(500);
  });
});

describe("myrmidon(WORKSPACE-HYGIENE): changing the quotas", () => {
  it("lets an instance admin write and reports the new value", async () => {
    const h = harness();
    const res = await request(h.withActor(admin)).patch(URL).send({ workspaceQuotaMb: 6000 }).expect(200);

    expect(h.updated).toEqual([
      { workspaceHygiene: { workspaceQuotaMb: 6000, totalQuotaMb: null } },
    ]);
    expect(res.body.quota).toEqual({
      workspaceQuotaMb: 6000,
      totalQuotaMb: null,
      sources: { workspaceQuotaMb: "settings", totalQuotaMb: "settings" },
    });
  });

  it("audits the change for every company with the previous and the next value", async () => {
    const h = harness({ companyIds: [COMPANY_ID, "company-b"] });
    await request(h.withActor(admin)).patch(URL).send({ totalQuotaMb: 30000 }).expect(200);

    expect(h.audits).toHaveLength(2);
    for (const entry of h.audits) {
      expect(entry).toMatchObject({
        action: WORKSPACE_HYGIENE_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: "workspace-hygiene",
      });
      expect(entry.details).toEqual({
        previous: { workspaceQuotaMb: 2048, totalQuotaMb: null },
        next: { workspaceQuotaMb: 2048, totalQuotaMb: 30000 },
        changedKeys: ["totalQuotaMb"],
      });
    }
    expect(h.audits.map((entry) => entry.companyId)).toEqual([COMPANY_ID, "company-b"]);
  });

  it("can switch a quota off with null", async () => {
    const h = harness({ stored: { workspaceQuotaMb: 3000, totalQuotaMb: 9000 } });
    const res = await request(h.withActor(admin)).patch(URL).send({ workspaceQuotaMb: null }).expect(200);
    expect(h.updated).toEqual([
      { workspaceHygiene: { workspaceQuotaMb: null, totalQuotaMb: 9000 } },
    ]);
    expect(res.body.quota.workspaceQuotaMb).toBeNull();
  });

  it("lets a board member read but not write", async () => {
    const h = harness();
    await request(h.withActor(member)).get(URL).expect(200);
    await request(h.withActor(member)).patch(URL).send({ workspaceQuotaMb: 6000 }).expect(403);
    await request(h.withActor(agentActor)).patch(URL).send({ workspaceQuotaMb: 6000 }).expect(403);
    expect(h.updated).toEqual([]);
  });

  it("refuses values that are not a positive integer and writes nothing", async () => {
    const h = harness();
    for (const body of [
      { workspaceQuotaMb: 0 },
      { workspaceQuotaMb: -3 },
      { workspaceQuotaMb: 1.5 },
      { workspaceQuotaMb: "4096" },
      { totalQuotaMb: "30000" },
      { workspaceQuotaMb: 4096, bogus: 1 },
      { workspaceQuotaMb: 4096, totalQuotaMb: -1 },
    ]) {
      await request(h.withActor(admin)).patch(URL).send(body).expect(400);
    }
    expect(h.updated).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("keeps the environment values in force when the settings write fails", async () => {
    const h = harness();
    vi.spyOn(h.deps.settings, "updateGeneral").mockRejectedValue(new Error("database is down"));
    await request(h.withActor(admin)).patch(URL).send({ workspaceQuotaMb: 9000 }).expect(500);
    expect(h.audits).toEqual([]);
  });
});