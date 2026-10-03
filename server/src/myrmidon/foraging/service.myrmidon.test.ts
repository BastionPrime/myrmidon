// myrmidon(1.6-FORAGE): the sweep pass against an in-memory store and a fake
// reader — the three acceptance rules of the ticket live here: a changed source
// produces a diff, a finding becomes a candidate through the port (the port
// stands in for SKILL-LIFECYCLE), and the budget stops the pass.
import { describe, expect, it, vi } from "vitest";
import type { ForagingCandidateInput, ForagingCandidatePort } from "./domain.js";
import { createForagingService } from "./service.js";
import type { ForagingReader } from "./service.js";
import type {
  ForagingFindingInsert,
  ForagingFindingRow,
  ForagingSourceInput,
  ForagingSourceRow,
  ForagingStore,
} from "./store.js";

interface MemoryStore extends ForagingStore {
  sources: Map<string, ForagingSourceRow>;
  findings: ForagingFindingRow[];
}

function createMemoryStore(rows: Array<Partial<ForagingSourceRow> & { id: string; role: string; url: string }>): MemoryStore {
  const sources = new Map<string, ForagingSourceRow>();
  for (const row of rows) {
    sources.set(row.id, {
      id: row.id,
      companyId: row.companyId ?? "company-a",
      role: row.role,
      url: row.url,
      kind: row.kind ?? "url",
      enabled: row.enabled ?? true,
      lastSnapshot: row.lastSnapshot ?? null,
      lastSnapshotAt: row.lastSnapshotAt ?? null,
      lastCheckedAt: row.lastCheckedAt ?? null,
      lastError: row.lastError ?? null,
    });
  }
  const findings: ForagingFindingRow[] = [];
  const patches: Array<{ id: string; lastSnapshot: string[] }> = [];
  const store: MemoryStore = {
    sources,
    findings,
    async listSources() {
      return [...sources.values()];
    },
    async enabledSources() {
      return [...sources.values()].filter((source) => source.enabled);
    },
    async upsertSource(companyId: string, input: ForagingSourceInput) {
      const existing = [...sources.values()].find(
        (source) => source.companyId === companyId && source.role === input.role && source.url === input.url,
      );
      if (existing) {
        existing.kind = input.kind;
        existing.enabled = input.enabled ?? true;
        return existing;
      }
      const created: ForagingSourceRow = {
        id: `source-${sources.size + 1}`,
        companyId,
        role: input.role,
        url: input.url,
        kind: input.kind,
        enabled: input.enabled ?? true,
        lastSnapshot: null,
        lastSnapshotAt: null,
        lastCheckedAt: null,
        lastError: null,
      };
      sources.set(created.id, created);
      return created;
    },
    async deleteSource(_companyId: string, sourceId: string) {
      return sources.delete(sourceId);
    },
    async saveSnapshot(_companyId: string, sourceId: string, patch) {
      const source = sources.get(sourceId);
      if (source) {
        source.lastSnapshot = patch.lastSnapshot;
        source.lastSnapshotAt = patch.lastSnapshotAt;
        source.lastCheckedAt = patch.lastCheckedAt;
        source.lastError = patch.lastError;
      }
      patches.push({ id: sourceId, lastSnapshot: patch.lastSnapshot });
    },
    async saveRead(_companyId: string, sourceId: string, patch) {
      const source = sources.get(sourceId);
      if (source) {
        source.lastCheckedAt = patch.lastCheckedAt;
        source.lastError = patch.lastError;
      }
    },
    async insertFinding(input: ForagingFindingInsert) {
      const finding: ForagingFindingRow = { ...input, id: `finding-${findings.length + 1}` };
      findings.push(finding);
      return finding;
    },
    async listFindings(_companyId: string, limit: number) {
      return findings.slice(0, limit);
    },
    async listUnverifiedFindings(_companyId: string, limit: number) {
      return findings.filter((finding) => finding.status === "unverified").slice(0, limit);
    },
    async markFindingCandidate(_companyId: string, findingId: string, status, candidateRef, reason) {
      const finding = findings.find((item) => item.id === findingId);
      if (finding) {
        finding.status = status;
        finding.candidateRef = candidateRef;
        finding.reason = reason;
      }
    },
    async monthFindingCount() {
      return findings.length;
    },
    async listCompanyIds() {
      return [...new Set([...sources.values()].map((source) => source.companyId))];
    },
  };
  return store;
}

function fakeReader(bodies: Record<string, string>): ForagingReader {
  return {
    async read(source) {
      const body = bodies[source.url];
      if (body === undefined) throw new Error("unreachable in test");
      return { text: body, bytes: body.length };
    },
  };
}

const EMPTY_PORT: ForagingCandidatePort = {
  available: false,
  async createFindingCandidate() {
    return null;
  },
};

describe("myrmidon(1.6-FORAGE) sweep pass", () => {
  it("records a baseline on the first read and no finding", async () => {
    const store = createMemoryStore([{ id: "s1", role: "engineer", url: "https://example.com/a" }]);
    const service = createForagingService({
      store,
      reader: fakeReader({ "https://example.com/a": "one\ntwo\n" }),
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    const result = await service.runPass("company-a");
    expect(result.sourcesRead).toBe(1);
    expect(result.findings).toBe(0);
    expect(store.sources.get("s1")?.lastSnapshot).toEqual(["one", "two"]);
  });

  it("produces a diff finding when the source changed since the last snapshot", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["one", "two"] },
    ]);
    const service = createForagingService({
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo\nthree\n" }),
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    const result = await service.runPass("company-a");
    expect(result.findings).toBe(1);
    const [finding] = store.findings;
    expect(finding.diff).toEqual({ added: ["three"], removed: [] });
    expect(finding.skillKey).toBe("foraged-smm");
    expect(finding.status).toBe("unverified");
  });

  it("opens no finding when the source is unchanged", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["two", "one"] },
    ]);
    const service = createForagingService({
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo" }),
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    const result = await service.runPass("company-a");
    expect(result.findings).toBe(0);
    expect(store.findings).toHaveLength(0);
  });

  it("turns a finding into a candidate through the port (stand-in for SKILL-LIFECYCLE)", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["one"] },
    ]);
    const createFindingCandidate = vi.fn(
      async (_input: ForagingCandidateInput): Promise<string | null> => "candidate-42",
    );
    const port: ForagingCandidatePort = { available: true, createFindingCandidate };
    const service = createForagingService({
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo" }),
      candidatePort: port,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    const result = await service.runPass("company-a");
    expect(createFindingCandidate).toHaveBeenCalledTimes(1);
    expect(createFindingCandidate.mock.calls[0][0]).toMatchObject({
      companyId: "company-a",
      sourceId: "s1",
      role: "smm",
      skillKey: "foraged-smm",
      diff: { added: ["two"], removed: [] },
    });
    expect(result.candidates).toBe(1);
    expect(store.findings[0].status).toBe("candidate");
    expect(store.findings[0].candidateRef).toBe("candidate-42");
  });

  it("keeps a finding unverified when the port refuses it", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "smm", url: "https://example.com/feed", lastSnapshot: ["one"] },
    ]);
    const port: ForagingCandidatePort = { available: true, async createFindingCandidate() { return null; } };
    const service = createForagingService({
      store,
      reader: fakeReader({ "https://example.com/feed": "one\ntwo" }),
      candidatePort: port,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    await service.runPass("company-a");
    expect(store.findings[0].status).toBe("rejected");
  });

  it("stops the pass once the budget ceiling is reached", async () => {
    // Two sources: the first is read (1 cent), the ceiling is 1 cent, so the
    // second is never read and the pass reports the stop.
    const store = createMemoryStore([
      { id: "s1", role: "a", url: "https://example.com/one", lastSnapshot: ["x"] },
      { id: "s2", role: "b", url: "https://example.com/two", lastSnapshot: ["y"] },
    ]);
    const read = vi.fn(async (source: { url: string }) => ({ text: "x", bytes: 1024 }));
    const service = createForagingService({
      store,
      reader: { read },
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 1, enabled: true } },
    });
    const result = await service.runPass("company-a");
    expect(result.stoppedByBudget).toBe(true);
    expect(result.sourcesRead).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.spentCents).toBe(1);
  });

  it("continues the pass when one source fails, recording the error", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "a", url: "https://example.com/broken" },
      { id: "s2", role: "b", url: "https://example.com/ok" },
    ]);
    const service = createForagingService({
      store,
      reader: {
        async read(source) {
          if (source.url.endsWith("broken")) throw new Error("source answered 500");
          return { text: "ok", bytes: 2 };
        },
      },
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    const result = await service.runPass("company-a");
    expect(result.errors).toBe(1);
    expect(result.sourcesRead).toBe(1);
    expect(store.sources.get("s1")?.lastError).toContain("500");
  });

  it("skips disabled sources", async () => {
    const store = createMemoryStore([
      { id: "s1", role: "a", url: "https://example.com/off", enabled: false },
    ]);
    const service = createForagingService({
      store,
      reader: fakeReader({ "https://example.com/off": "x" }),
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 0, enabled: false } },
    });
    const result = await service.runPass("company-a");
    expect(result.sourcesRead).toBe(0);
  });

  it("reports the budget state for the screen", async () => {
    const store = createMemoryStore([{ id: "s1", role: "a", url: "https://example.com/" }]);
    const service = createForagingService({
      store,
      reader: fakeReader({}),
      candidatePort: EMPTY_PORT,
      settings: { budget: { maxCostCents: 50, enabled: true } },
    });
    const state = await service.budgetState("company-a");
    expect(state.maxCostCents).toBe(50);
    expect(state.spentCents).toBeLessThanOrEqual(50);
  });
});