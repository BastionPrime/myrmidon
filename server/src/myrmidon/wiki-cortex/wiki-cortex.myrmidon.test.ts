// myrmidon(1.6-WIKI): the regulation lifecycle and the resolver the delivery path reads.
//
// Plain in-memory store: the service is pure over its store, so the whole
// lifecycle runs here without a database.

import { describe, expect, it } from "vitest";
import { loadRegulationWorkspaceFiles } from "./delivery.js";
import { REGULATIONS_WORKSPACE_FILE, renderRegulationsMarkdown } from "./render.js";
import { createWikiRegulationService, type RegulationStore } from "./service.js";
import type { RegulationPageRecord } from "./types.js";

const COMPANY = "company-1";

function memoryStore(): RegulationStore & { rows: Map<string, RegulationPageRecord> } {
  const rows = new Map<string, RegulationPageRecord>();
  const key = (companyId: string, slug: string) => `${companyId}::${slug}`;
  return {
    rows,
    async list(companyId) {
      return [...rows.values()].filter((row) => row.companyId === companyId);
    },
    async get(companyId, slug) {
      return rows.get(key(companyId, slug)) ?? null;
    },
    async put(page) {
      rows.set(key(page.companyId, page.slug), structuredClone(page));
      return structuredClone(page);
    },
  };
}

let ids = 0;
function serviceWith(store: RegulationStore, at = "2026-01-01T00:00:00.000Z") {
  let tick = 0;
  return createWikiRegulationService(store, {
    now: () => new Date(new Date(at).getTime() + tick++ * 1000),
    newId: () => `page-${++ids}`,
  });
}

async function approvedPage(service: ReturnType<typeof serviceWith>, content: string, roles: string[] = ["engineer"]) {
  await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles, content });
  return service.approve(COMPANY, "deploy/oncall");
}

describe("myrmidon(1.6-WIKI) regulation lifecycle", () => {
  it("keeps a draft out of delivery and delivers an approved text", async () => {
    const store = memoryStore();
    const service = serviceWith(store);

    await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles: ["engineer"], content: "v1 text" });
    expect(await service.resolved(COMPANY, "engineer")).toEqual([]);

    await service.approve(COMPANY, "deploy/oncall");
    const delivered = await service.resolved(COMPANY, "engineer");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.content).toBe("v1 text");
    expect(delivered[0]!.version).toBe(1);
    expect(delivered[0]!.title).toBe("On-call rotation");
  });

  it("requires approval for a change of an approved regulation", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");

    const edited = await service.save(COMPANY, {
      slug: "deploy/oncall",
      title: "On-call rotation",
      roles: ["engineer"],
      content: "v2 text",
    });
    expect(edited.status).toBe("draft");
    expect(edited.revisionNumber).toBe(2);

    // The fleet keeps reading the approved revision while the edit waits.
    const whileDraft = await service.resolved(COMPANY, "engineer");
    expect(whileDraft.map((regulation) => regulation.content)).toEqual(["v1 text"]);
    expect(whileDraft[0]!.version).toBe(1);

    await service.approve(COMPANY, "deploy/oncall");
    const afterApproval = await service.resolved(COMPANY, "engineer");
    expect(afterApproval.map((regulation) => regulation.content)).toEqual(["v2 text"]);
    expect(afterApproval[0]!.version).toBe(2);
  });

  it("approves a revision once (a repeated approval adds no revision)", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");

    const again = await service.approve(COMPANY, "deploy/oncall");
    expect(again.revisionNumber).toBe(1);
    expect(again.revisions).toHaveLength(1);
    expect(again.status).toBe("approved");
  });

  it("delivers only to the roles a regulation names", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles: ["engineer"], content: "engineer text" });
    await service.approve(COMPANY, "deploy/oncall");
    await service.save(COMPANY, { slug: "brand/voice", title: "Brand voice", roles: ["*"], content: "everyone text" });
    await service.approve(COMPANY, "brand/voice");

    expect((await service.resolved(COMPANY, "engineer")).map((regulation) => regulation.slug)).toEqual([
      "brand/voice",
      "deploy/oncall",
    ]);
    expect((await service.resolved(COMPANY, "designer")).map((regulation) => regulation.slug)).toEqual(["brand/voice"]);
  });

  it("keeps a role with no approved regulation empty", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles: ["engineer"], content: "v1 text" });
    expect(await service.resolved(COMPANY, "designer")).toEqual([]);
  });
});

describe("myrmidon(1.6-WIKI) rollback", () => {
  it("restores the previous version and records the rollback as a new revision", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");
    await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles: ["engineer"], content: "v2 text" });
    await service.approve(COMPANY, "deploy/oncall");

    const rolledBack = await service.rollback(COMPANY, "deploy/oncall", 1);
    expect(rolledBack.revisionNumber).toBe(3);
    expect(rolledBack.status).toBe("approved");
    expect(rolledBack.content).toBe("v1 text");
    expect(rolledBack.revisions).toHaveLength(3);
    expect(rolledBack.revisions[2]!.changeSummary).toBe("rolled back to revision 1");

    const delivered = await service.resolved(COMPANY, "engineer");
    expect(delivered.map((regulation) => regulation.content)).toEqual(["v1 text"]);

    // The rollback is itself a revision, so rolling it back is possible too.
    const reRolled = await service.rollback(COMPANY, "deploy/oncall", 2);
    expect(reRolled.content).toBe("v2 text");
    expect(reRolled.revisionNumber).toBe(4);
  });

  it("stops delivering a newer text when the rollback goes back to a draft revision", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");
    await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles: ["engineer"], content: "v2 text" });
    await service.approve(COMPANY, "deploy/oncall");
    await service.save(COMPANY, { slug: "deploy/oncall", title: "On-call rotation", roles: ["engineer"], content: "v3 text" });

    const rolledBack = await service.rollback(COMPANY, "deploy/oncall", 3);
    expect(rolledBack.status).toBe("draft");
    expect((await service.resolved(COMPANY, "engineer")).map((regulation) => regulation.content)).toEqual(["v2 text"]);
  });

  it("refuses an unknown revision", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");
    await expect(service.rollback(COMPANY, "deploy/oncall", 9)).rejects.toThrow(/has no revision 9/);
  });
});

describe("myrmidon(1.6-WIKI) delivered bytes", () => {
  it("renders the same bytes while an edit is unapproved (the profile hash must not move)", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text", ["engineer", "*"]);
    const before = renderRegulationsMarkdown(await service.resolved(COMPANY, "engineer"));

    await service.save(COMPANY, {
      slug: "deploy/oncall",
      title: "On-call rotation",
      roles: ["engineer", "*"],
      content: "v2 text",
    });
    const after = renderRegulationsMarkdown(await service.resolved(COMPANY, "engineer"));
    expect(after).toBe(before);
  });

  it("writes one workspace file for the agent's role and nothing for an empty wiki", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");

    const delivery = await loadRegulationWorkspaceFiles(service, { companyId: COMPANY, role: "engineer" });
    expect(delivery.warnings).toEqual([]);
    expect(delivery.files.map((file) => file.path)).toEqual([REGULATIONS_WORKSPACE_FILE]);
    expect(delivery.files[0]!.content).toContain("v1 text");
    expect(delivery.files[0]!.content).toContain("On-call rotation");
    expect(delivery.files[0]!.content).toContain("deploy/oncall");

    const empty = await loadRegulationWorkspaceFiles(service, { companyId: "company-2", role: "engineer" });
    expect(empty).toEqual({ files: [], warnings: [] });
    const otherRole = await loadRegulationWorkspaceFiles(service, { companyId: COMPANY, role: "designer" });
    expect(otherRole).toEqual({ files: [], warnings: [] });
  });

  it("does not shadow a REGULATIONS.md the agent's own bundle ships", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    await approvedPage(service, "v1 text");

    const delivery = await loadRegulationWorkspaceFiles(
      service,
      { companyId: COMPANY, role: "engineer" },
      { takenPaths: ["HEARTBEAT.md", "REGULATIONS.md"] },
    );
    expect(delivery.files).toEqual([]);
    expect(delivery.warnings).toHaveLength(1);
    expect(delivery.warnings[0]).toMatch(/already contains REGULATIONS\.md/);
  });
});

describe("myrmidon(1.6-WIKI) input rules", () => {
  it("normalizes roles and refuses an empty title or content", async () => {
    const store = memoryStore();
    const service = serviceWith(store);
    const page = await service.save(COMPANY, {
      slug: "Deploy/OnCall",
      title: "On-call rotation",
      roles: ["engineer", "engineer", "  "],
      content: "v1 text",
    });
    expect(page.slug).toBe("deploy/oncall");
    expect(page.roles).toEqual(["engineer"]);

    const everyone = await service.save(COMPANY, { slug: "brand/voice", title: "Brand voice", content: "text" });
    expect(everyone.roles).toEqual(["*"]);

    await expect(service.save(COMPANY, { slug: "deploy/oncall", title: "", content: "text" })).rejects.toThrow(/title/);
    await expect(service.save(COMPANY, { slug: "Not A Slug", title: "t", content: "text" })).rejects.toThrow(/slug/);
  });
});