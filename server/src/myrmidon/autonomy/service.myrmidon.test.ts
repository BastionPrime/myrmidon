// myrmidon(1.6-AUTONOMY): the autonomy service — matrix versioning, the
// regulation draft → approved model, revisions and rollback, and the change log.
//
// The service takes its storage and its audit sink by injection, so these tests
// run the real domain code over an in-memory document and a recording activity
// sink. That is the same seam the routes use in the route test.
//
// Neutral data only: agent-a, company-a, example.com.

import { describe, expect, it, vi } from "vitest";
import { AUTONOMY_SAFE_DEFAULTS, type AutonomyChangeLogEntry } from "@paperclipai/shared";
import { autonomyService, AUTONOMY_ACTIVITY_SOURCE } from "./service.js";
import { memoryAutonomyStore } from "./store.js";

const COMPANY_ID = "company-a";
const ACTOR = { type: "board" as const, id: "user-a" };

function harness() {
  const changeLog: AutonomyChangeLogEntry[] = [];
  let seq = 0;
  const service = autonomyService({
    store: memoryAutonomyStore(),
    now: () => new Date("2026-10-02T00:00:00.000Z"),
    newId: () => `id-${++seq}`,
    logActivity: vi.fn(async (input) => {
      changeLog.push({
        id: `log-${changeLog.length + 1}`,
        at: "2026-10-02T00:00:00.000Z",
        actor: { type: input.actorType === "agent" ? "agent" : input.actorType === "system" ? "system" : "board", id: input.actorId },
        action: input.action.slice(`${AUTONOMY_ACTIVITY_SOURCE}.`.length) as AutonomyChangeLogEntry["action"],
        summary: String(input.details.summary ?? ""),
        matrixVersion: typeof input.details.matrixVersion === "number" ? input.details.matrixVersion : null,
        regulationId: typeof input.details.regulationId === "string" ? input.details.regulationId : null,
      });
    }),
    listChangeLog: async (_companyId, limit) => changeLog.slice(0, limit),
  });
  return { service, changeLog };
}

describe("myrmidon(1.6-AUTONOMY) matrix editing", () => {
  it("starts from the all-allowed factory default and bumps the version on every accepted edit", async () => {
    const { service } = harness();
    const initial = await service.readMatrix();
    expect(initial.version).toBe(1);
    expect(initial.rules).toEqual([]);
    expect(initial.defaults).toEqual(AUTONOMY_SAFE_DEFAULTS);

    const first = await service.updateMatrix(COMPANY_ID, ACTOR, {
      expectedVersion: 1,
      rules: [{ role: "engineer", actionClass: "merge", verdict: "approval_required" }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.version).toBe(2);

    const second = await service.updateMatrix(COMPANY_ID, ACTOR, {
      expectedVersion: 2,
      rules: first.value.rules,
      defaults: first.value.defaults,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.version).toBe(3);
  });

  it("refuses a stale expected version instead of overwriting a concurrent edit", async () => {
    const { service } = harness();
    await service.updateMatrix(COMPANY_ID, ACTOR, {
      expectedVersion: 1,
      rules: [],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    });
    const stale = await service.updateMatrix(COMPANY_ID, ACTOR, {
      expectedVersion: 1,
      rules: [],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.failure).toEqual({ kind: "version_conflict", expectedVersion: 1, actualVersion: 2 });
    // The refused write changed nothing.
    expect((await service.readMatrix()).version).toBe(2);
  });

  it("appends a change-log row per accepted edit and none for a refused one", async () => {
    const { service, changeLog } = harness();
    await service.updateMatrix(COMPANY_ID, ACTOR, {
      expectedVersion: 1,
      rules: [{ role: "engineer", actionClass: "merge", verdict: "forbidden" }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    });
    await service.updateMatrix(COMPANY_ID, ACTOR, {
      expectedVersion: 99,
      rules: [],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    });
    expect(changeLog).toHaveLength(1);
    expect(changeLog[0]!.action).toBe("matrix_edit");
    expect(changeLog[0]!.matrixVersion).toBe(2);
  });
});

describe("myrmidon(1.6-AUTONOMY) regulations: draft → approved with revisions", () => {
  it("creates a regulation as draft revision 1", async () => {
    const { service } = harness();
    const created = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "Engineering conduct",
      bodyMarkdown: "Ask before merging.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe("draft");
    expect(created.value.revision).toBe(1);
    expect(created.value.revisions).toHaveLength(1);
    expect(created.value.wikiPageId).toBeNull();
  });

  it("edits append a new draft revision and drop an approved regulation back to draft", async () => {
    const { service } = harness();
    const created = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "Engineering conduct",
      bodyMarkdown: "Ask before merging.",
    });
    if (!created.ok) throw new Error("create failed");
    const approved = await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);
    expect(approved.ok).toBe(true);

    const edited = await service.updateRegulation(COMPANY_ID, ACTOR, {
      id: created.value.id,
      bodyMarkdown: "Ask before merging, and before deploying.",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.status).toBe("draft");
    expect(edited.value.revision).toBe(2);
    expect(edited.value.revisions).toHaveLength(2);
    expect(edited.value.revisions[0]!.status).toBe("approved");
    expect(edited.value.revisions[1]!.status).toBe("draft");
  });

  it("approves the current draft and keeps the prior approved revision retrievable", async () => {
    const { service, changeLog } = harness();
    const created = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "Engineering conduct",
      bodyMarkdown: "v1",
    });
    if (!created.ok) throw new Error("create failed");
    await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);
    await service.updateRegulation(COMPANY_ID, ACTOR, { id: created.value.id, bodyMarkdown: "v2" });
    const approved = await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.status).toBe("approved");
    // Approval promotes the current revision in place: it does not add one.
    expect(approved.value.revision).toBe(2);
    // Revision 1 (the earlier approved text) is still in the history.
    const v1 = approved.value.revisions.find((entry) => entry.revision === 1);
    expect(v1?.bodyMarkdown).toBe("v1");
    expect(v1?.status).toBe("approved");
    expect(changeLog.map((entry) => entry.action)).toEqual([
      "regulation_created",
      "regulation_approved",
      "regulation_edited",
      "regulation_approved",
    ]);
  });

  it("re-promotes an earlier revision as a new approved revision on restore", async () => {
    const { service } = harness();
    const created = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "Engineering conduct",
      bodyMarkdown: "v1",
    });
    if (!created.ok) throw new Error("create failed");
    await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);
    await service.updateRegulation(COMPANY_ID, ACTOR, { id: created.value.id, bodyMarkdown: "v2" });
    await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);

    const restored = await service.restoreRegulationRevision(COMPANY_ID, ACTOR, { id: created.value.id, toRevision: 1 });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.status).toBe("approved");
    expect(restored.value.bodyMarkdown).toBe("v1");
    expect(restored.value.revision).toBe(3);
  });

  it("supersedes the earlier approved regulation for the same role", async () => {
    const { service } = harness();
    const first = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "First",
      bodyMarkdown: "first",
    });
    if (!first.ok) throw new Error("create failed");
    await service.approveRegulation(COMPANY_ID, ACTOR, first.value.id);
    const second = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "Second",
      bodyMarkdown: "second",
    });
    if (!second.ok) throw new Error("create failed");
    await service.approveRegulation(COMPANY_ID, ACTOR, second.value.id);

    const snapshot = await service.snapshot(COMPANY_ID);
    const superseded = snapshot.regulations.find((entry) => entry.id === first.value.id);
    expect(superseded?.supersededBy).toBe(second.value.id);
  });

  it("reports typed refusals for a missing regulation, a missing revision and a double approval", async () => {
    const { service } = harness();
    const missing = await service.approveRegulation(COMPANY_ID, ACTOR, "nope");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.kind).toBe("regulation_not_found");

    const created = await service.createRegulation(COMPANY_ID, ACTOR, {
      role: "engineer",
      title: "T",
      bodyMarkdown: "b",
    });
    if (!created.ok) throw new Error("create failed");
    await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);
    const again = await service.approveRegulation(COMPANY_ID, ACTOR, created.value.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.failure.kind).toBe("already_approved");

    const noRevision = await service.restoreRegulationRevision(COMPANY_ID, ACTOR, {
      id: created.value.id,
      toRevision: 99,
    });
    expect(noRevision.ok).toBe(false);
    if (!noRevision.ok) expect(noRevision.failure.kind).toBe("revision_not_found");
  });
});