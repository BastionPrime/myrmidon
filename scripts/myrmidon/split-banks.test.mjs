import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  API_PREFIX,
  classifyDocument,
  classifyDocuments,
  joinUrl,
  loadSplitState,
  main,
  makeBatches,
  newSplitState,
  runCopy,
  runDelta,
  runPurge,
  runRollback,
  runVerify,
  saveSplitState,
} from "./split-banks.mjs";

// Synthetic data only: fake ids, fake hashes, and an in-memory mock of the
// hindsight API (asynchronous export/import operations, archive download,
// multipart upload, config, memory listing, observation clearing). No real
// address, no real memory content anywhere.

const SOURCE = "source-bank";
const T0 = "2026-09-29T00:00:00.000Z";
const BEFORE_T0 = "2026-09-28T10:00:00.000Z";
const AFTER_T0 = "2026-09-29T12:00:00.000Z";
const VERIFIED_AT = "2026-09-29T13:00:00.000Z";
const FAST = { sleep: async () => {} };

const MAP = {
  byAgentIdentity: { "agent-a": "bank-a", "agent-b": "bank-b" },
  byAgentId: {
    "11111111-1111-1111-1111-111111111111": "bank-a",
    "22222222-2222-2222-2222-222222222222": "bank-b",
  },
  byOperatorTag: { "operator-tag": SOURCE },
  byDomainTag: { "domain-a": "bank-a", "domain-b": "bank-b" },
};

function doc(id, overrides = {}) {
  return {
    id,
    units: { world: 2, experience: 1 },
    meta: {},
    textSha256: `sha256-${id}`,
    updatedAt: BEFORE_T0,
    ...overrides,
  };
}

/** Documents of two authors, a domain-tagged one, the source's own and one with no author. */
function syntheticSource() {
  return [
    doc("doc-a-1", { meta: { agentIdentity: "agent-a" }, units: { world: 10, experience: 4 } }),
    doc("doc-a-2", { meta: { agentId: "11111111-1111-1111-1111-111111111111" }, units: { world: 6, experience: 2 } }),
    doc("doc-b-1", { meta: { agentIdentity: "agent-b" }, units: { world: 3, experience: 3 } }),
    doc("doc-op-1", { meta: { tags: ["operator-tag"] }, units: { world: 1, experience: 0 } }),
    doc("doc-dom-1", { meta: { tags: ["domain:domain-a"] }, units: { world: 5, experience: 5 } }),
    doc("doc-none-1", { units: { world: 1, experience: 1 } }),
  ];
}

/** In-memory hindsight API. `calls` logs every request as "METHOD path". */
function mockService() {
  const banks = new Map();
  const calls = [];
  const operations = new Map();
  const archives = new Map();
  const missions = {};
  const configPatches = [];
  const failDelete = new Set();
  const limits = { pageCap: 1000 };
  let seq = 0;

  const bank = (id) => {
    if (!banks.has(id)) {
      banks.set(id, {
        docs: new Map(),
        memories: [],
        observations: [],
        config: { enable_auto_consolidation: true },
        resets: new Set(),
      });
    }
    return banks.get(id);
  };
  const reply = (status, json = null) => ({ status, json });
  const newOperation = (result) => {
    const id = `op-${++seq}`;
    operations.set(id, { polls: 0, result });
    return id;
  };
  const downloadPrefix = `${API_PREFIX}/files/download/`;

  const transport = {
    async request(method, urlPath, body) {
      calls.push(`${method} ${urlPath}`);
      const url = new URL(urlPath, "http://mock.invalid");
      const parts = url.pathname.split("/").map(decodeURIComponent);
      assert.deepEqual(parts.slice(0, 4), ["", "v1", "default", "banks"], `unexpected path ${urlPath}`);
      const bankId = parts[4];
      const rest = parts.slice(5).join("/");
      const b = bank(bankId);
      if (method === "PUT" && rest === "") {
        assert.equal(Object.hasOwn(body, "mission"), false, "the deprecated mission field must not be sent");
        if (body.reflect_mission) missions[bankId] = body.reflect_mission;
        return reply(200, { bank_id: bankId });
      }
      if (method === "POST" && rest === "document-transfer/export") {
        const found = url.searchParams.getAll("document_id").filter((id) => b.docs.has(id));
        const operationId = `op-${++seq}`;
        const key = `exports/${operationId}.zip`;
        const data = Buffer.from(JSON.stringify(found.map((id) => ({ id, ...b.docs.get(id) }))));
        archives.set(key, data);
        operations.set(operationId, {
          polls: 0,
          result: { storage_key: key, download_url: `${downloadPrefix}${key}`, byte_size: data.length, filename: "documents.zip" },
        });
        return reply(202, { operation_id: operationId, status: "pending" });
      }
      if (method === "GET" && rest.startsWith("operations/")) {
        const op = operations.get(parts[6]);
        if (!op) return reply(404);
        op.polls += 1;
        const done = op.polls >= 2;
        return reply(200, { operation_id: parts[6], status: done ? "completed" : "processing", result_metadata: done ? op.result : null });
      }
      if (rest === "config") {
        if (method === "PATCH") {
          Object.assign(b.config, body.updates);
          configPatches.push(body.updates.enable_auto_consolidation);
        }
        return reply(200, { bank_id: bankId, config: { ...b.config }, overrides: {} });
      }
      if (method === "GET" && rest === "memories/list") {
        const type = url.searchParams.get("type");
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), limits.pageCap);
        const all =
          type === "observation"
            ? b.observations.map((o) => ({ id: o.id, fact_type: "observation", document_id: null, source_memory_ids: o.sources }))
            : b.memories.filter((m) => m.factType === type).map((m) => ({ id: m.id, fact_type: m.factType, document_id: m.documentId }));
        return reply(200, { items: all.slice(offset, offset + limit), total: all.length, limit, offset });
      }
      const clear = /^memories\/([^/]+)\/observations$/.exec(rest);
      if (method === "DELETE" && clear) {
        const before = b.observations.length;
        b.observations = b.observations.filter((o) => !o.sources.includes(clear[1]));
        b.resets.add(clear[1]);
        return reply(200, { deleted_count: before - b.observations.length });
      }
      const del = /^documents\/([^/]+)$/.exec(rest);
      if (method === "DELETE" && del) {
        if (failDelete.has(del[1])) return reply(500);
        if (!b.docs.delete(del[1])) return reply(404);
        // Deleting a document removes its facts but NOT the observations built from them.
        b.memories = b.memories.filter((m) => m.documentId !== del[1]);
        return reply(200, { success: true });
      }
      return reply(404);
    },
    async upload(urlPath, file) {
      calls.push(`UPLOAD ${urlPath}`);
      const url = new URL(urlPath, "http://mock.invalid");
      const parts = url.pathname.split("/").map(decodeURIComponent);
      assert.equal(parts[5], "document-transfer");
      const target = bank(parts[4]);
      const mode = url.searchParams.get("on_conflict");
      let imported = 0;
      let skipped = 0;
      for (const { id, ...rest } of JSON.parse(Buffer.from(file.data).toString())) {
        if (target.docs.has(id) && mode === "skip") skipped += 1;
        else {
          target.docs.set(id, rest);
          imported += 1;
        }
      }
      const operationId = newOperation({ documents_imported: imported, documents_skipped: skipped, facts_imported: 0 });
      return reply(202, { operation_id: operationId, status: "pending" });
    },
    async download(location) {
      calls.push(`DOWNLOAD ${location}`);
      if (!location.startsWith(downloadPrefix)) return { status: 404, data: null };
      const data = archives.get(decodeURIComponent(location.slice(downloadPrefix.length)));
      return data ? { status: 200, data } : { status: 404, data: null };
    },
  };

  return {
    transport,
    calls,
    missions,
    configPatches,
    failDelete,
    limits,
    bank,
    seed(bankId, docs) {
      for (const d of docs) bank(bankId).docs.set(d.id, { units: d.units, textSha256: d.textSha256, updatedAt: d.updatedAt });
    },
    seedMemories(bankId, facts, observations) {
      bank(bankId).memories = facts;
      bank(bankId).observations = observations;
    },
    listing(bankId) {
      return [...bank(bankId).docs].map(([id, v]) => ({ id, textSha256: v.textSha256, units: v.units, updatedAt: v.updatedAt }));
    },
    writes(from = 0) {
      return calls.slice(from).filter((c) => !c.startsWith("GET "));
    },
  };
}

/** A source bank with the synthetic documents, classified but not copied. */
function classified() {
  const svc = mockService();
  const docs = syntheticSource();
  svc.seed(SOURCE, docs);
  const state = newSplitState(SOURCE, T0);
  state.classifications = classifyDocuments(docs, MAP, SOURCE);
  return { svc, docs, state };
}

/** Copied and verified: the precondition of purge. */
async function copiedAndVerified() {
  const ctx = classified();
  await runCopy(ctx.svc.transport, ctx.state, {}, FAST);
  const verdict = runVerify(ctx.state, ctx.docs, { "bank-a": ctx.svc.listing("bank-a"), "bank-b": ctx.svc.listing("bank-b") });
  assert.equal(verdict.ok, true);
  ctx.state.verifiedAt = VERIFIED_AT;
  return ctx;
}

/** Facts and observations of the source bank for the purge scenarios. */
function seedPurgeMemories(svc) {
  const fact = (id, documentId, factType = "world") => ({ id, documentId, factType });
  svc.seedMemories(
    SOURCE,
    [
      fact("m-a1", "doc-a-1"),
      fact("m-a2", "doc-a-1", "experience"),
      fact("m-a3", "doc-a-2"),
      fact("m-b1", "doc-b-1"),
      fact("m-dom1", "doc-dom-1"),
      fact("m-op1", "doc-op-1"),
      fact("m-op2", "doc-op-1", "experience"),
      fact("m-none", "doc-none-1"),
      fact("m-own3", "doc-none-1", "experience"),
    ],
    [
      { id: "o-pure-a", sources: ["m-a1", "m-a2"] },
      { id: "o-pure-b", sources: ["m-b1"] },
      { id: "o-mixed", sources: ["m-a3", "m-op1"] },
      { id: "o-mixed-2", sources: ["m-dom1", "m-op2", "m-none"] },
      { id: "o-own", sources: ["m-own3"] },
      { id: "o-nosrc", sources: [] },
    ],
  );
}

function tmpDir() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "split-banks-"));
}

describe("split-banks classification", () => {
  const docs = syntheticSource();

  it("classifies by agent_identity, agentId, operator tag, domain tag; no author stays in the source bank", () => {
    const c = (i, source = SOURCE) => classifyDocument(docs[i], MAP, source);
    assert.deepEqual(c(0), { documentId: "doc-a-1", targetBank: "bank-a", rule: "agent_identity" });
    assert.deepEqual(c(1), { documentId: "doc-a-2", targetBank: "bank-a", rule: "agent_id" });
    assert.deepEqual(c(2), { documentId: "doc-b-1", targetBank: "bank-b", rule: "agent_identity" });
    assert.deepEqual(c(3), { documentId: "doc-op-1", targetBank: SOURCE, rule: "operator_tag" });
    assert.deepEqual(c(4), { documentId: "doc-dom-1", targetBank: "bank-a", rule: "domain_tag" });
    assert.deepEqual(c(5), { documentId: "doc-none-1", targetBank: SOURCE, rule: "no_author" });
  });

  it("the bank an unclassified document stays in is the argument, not a constant", () => {
    assert.equal(classifyDocument(docs[5], MAP, "another-source").targetBank, "another-source");
  });

  it("map keys are own properties only", () => {
    const tricky = doc("doc-x", { meta: { agentIdentity: "constructor", tags: ["domain:__proto__"] } });
    assert.equal(classifyDocument(tricky, MAP, SOURCE).rule, "no_author");
  });

  it("classifyDocuments keeps input order and count", () => {
    const list = classifyDocuments(docs, MAP, SOURCE);
    assert.deepEqual(list.map((c) => c.documentId), docs.map((d) => d.id));
  });
});

describe("split-banks batching", () => {
  it("splits by count and by the length of the export query", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `id-${i}`);
    assert.deepEqual(makeBatches(ids, 2), [["id-0", "id-1"], ["id-2", "id-3"], ["id-4"]]);
    const long = Array.from({ length: 4 }, (_, i) => `${"x".repeat(40)}${i}`);
    assert.deepEqual(makeBatches(long, 200, 100).map((b) => b.length), [1, 1, 1, 1]);
    assert.deepEqual(makeBatches(long, 200, 120).map((b) => b.length), [2, 2]);
  });
});

describe("split-banks copy over the real transfer flow", () => {
  it("export (async) -> download -> import (async); banks get reflect_mission; a repeat does nothing", async () => {
    const { svc, state } = classified();
    const first = await runCopy(svc.transport, state, { "bank-a": "mission text" }, FAST);
    assert.equal(first.counts.documentsMoved, 4);
    assert.equal(first.counts.banksCreated, 2);
    assert.equal(svc.bank("bank-a").docs.size, 3);
    assert.equal(svc.bank("bank-b").docs.size, 1);
    assert.equal(svc.bank(SOURCE).docs.size, 6); // nothing leaves the source before purge
    assert.equal(svc.missions["bank-a"], "mission text");
    assert.equal(svc.missions["bank-b"], undefined);
    const forBankA = svc.calls.filter((c) => c.includes("document_id=doc-a-1"));
    assert.equal(forBankA.length, 1);
    assert.match(forBankA[0], /^POST \/v1\/default\/banks\/source-bank\/document-transfer\/export\?document_id=doc-a-1&document_id=doc-a-2&document_id=doc-dom-1$/);
    assert.ok(svc.calls.some((c) => c.startsWith("DOWNLOAD /v1/default/files/download/exports/")));
    assert.ok(svc.calls.includes("UPLOAD /v1/default/banks/bank-a/document-transfer?on_conflict=skip"));
    assert.deepEqual([...state.copied].sort(), ["doc-a-1", "doc-a-2", "doc-b-1", "doc-dom-1"]);

    const seen = svc.calls.length;
    const second = await runCopy(svc.transport, state, {}, FAST);
    assert.equal(second.counts.documentsMoved, 0);
    assert.equal(svc.calls.length, seen);
  });

  it("counts a document that already exists in the target as skipped, not as an error", async () => {
    const { svc, state, docs } = classified();
    svc.seed("bank-a", [docs[0]]);
    const report = await runCopy(svc.transport, state, {}, FAST);
    assert.equal(report.counts.documentsSkipped, 1);
    assert.equal(report.counts.documentsImported, 3);
  });

  it("fails with counters when the export silently omits a requested document", async () => {
    const { svc, state } = classified();
    svc.bank(SOURCE).docs.delete("doc-b-1");
    await assert.rejects(runCopy(svc.transport, state, {}, FAST), /1 document\(s\) requested, the import accounted for 0/);
    assert.equal(state.copied.includes("doc-b-1"), false);
  });

  it("dry-run makes no request at all", async () => {
    const { svc, state } = classified();
    const report = await runCopy(svc.transport, state, {}, { dryRun: true });
    assert.equal(report.counts.documentsTotal, 4);
    assert.deepEqual(svc.calls, []);
    assert.deepEqual(state.copied, []);
  });
});

describe("split-banks verify against the source listing", () => {
  it("passes after a copy: counts, world/experience sums and (id, textSha256) match", async () => {
    const { svc, state, docs } = classified();
    await runCopy(svc.transport, state, {}, FAST);
    const result = runVerify(state, docs, { "bank-a": svc.listing("bank-a"), "bank-b": svc.listing("bank-b") });
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.equal(result.counts["bank-a.documents"], 3);
    assert.equal(result.counts["bank-a.world"], 21);
    assert.equal(result.counts["bank-a.experience"], 11);
    assert.equal(result.counts["bank-b.world"], 3);
  });

  it("flags a leak, a missing document, a content mismatch and a sum mismatch", async () => {
    const { svc, state, docs } = classified();
    await runCopy(svc.transport, state, {}, FAST);
    const bankA = svc.listing("bank-a").filter((d) => d.id !== "doc-a-2"); // missing
    bankA.find((d) => d.id === "doc-a-1").textSha256 = "tampered"; // content mismatch
    const bankB = [...svc.listing("bank-b"), { id: "doc-a-2", textSha256: "x", units: { world: 6, experience: 2 } }]; // leak
    bankB.find((d) => d.id === "doc-b-1").units = { world: 99, experience: 3 }; // sum mismatch
    const result = runVerify(state, docs, { "bank-a": bankA, "bank-b": bankB });
    assert.equal(result.ok, false);
    const text = result.findings.join("\n");
    assert.match(text, /doc-a-2 is missing from bank-a/);
    assert.match(text, /doc-a-1 in bank-a differs from the source/);
    assert.match(text, /doc-a-2 in bank-b belongs to bank-a \(leak\)/);
    assert.match(text, /bank-b has 105 world unit\(s\), expected 3/);
    assert.match(text, /bank-a has 2 document\(s\), expected 3/);
  });

  it("flags documents in a bank nobody classified there (a public bank must stay empty)", () => {
    const { state, docs } = classified();
    const result = runVerify(state, docs, { "public-bank": [{ id: "doc-a-1", textSha256: "x", units: { world: 1, experience: 1 } }] });
    assert.ok(result.findings.some((f) => f.includes("doc-a-1 in public-bank") && f.includes("leak")));
  });
});

describe("split-banks delta", () => {
  async function switched() {
    const ctx = await copiedAndVerified();
    // After the copy the source kept receiving writes: one document changed, one is new.
    ctx.svc.bank(SOURCE).docs.set("doc-a-1", { units: { world: 99, experience: 4 }, textSha256: "sha256-doc-a-1-v2", updatedAt: AFTER_T0 });
    ctx.svc.bank(SOURCE).docs.set("doc-new-1", { units: { world: 1, experience: 1 }, textSha256: "sha256-doc-new-1", updatedAt: AFTER_T0 });
    const listing = ctx.svc.listing(SOURCE).map((d) => ({ ...d, meta: d.id === "doc-new-1" ? { tags: ["domain:domain-b"] } : {} }));
    return { ...ctx, listing };
  }

  it("replaces changed documents, classifies new ones and records every moved id as copied", async () => {
    const { svc, state, listing } = await switched();
    const report = await runDelta(svc.transport, state, listing, MAP, {}, { ...FAST, since: T0 });
    assert.equal(report.counts.updatedSince, 2);
    assert.equal(report.counts.newlyClassified, 1);
    assert.equal(report.counts.documentsMoved, 2);
    assert.equal(svc.bank("bank-a").docs.get("doc-a-1").units.world, 99); // replaced, not skipped
    assert.ok(svc.bank("bank-b").docs.has("doc-new-1")); // a new document reached its bank
    assert.ok(state.copied.includes("doc-new-1"));
    assert.deepEqual(state.classifications.find((c) => c.documentId === "doc-new-1"), {
      documentId: "doc-new-1",
      targetBank: "bank-b",
      rule: "domain_tag",
    });
    assert.ok(svc.calls.some((c) => c.includes("on_conflict=replace")));
    assert.equal(state.verifiedAt, null); // a move invalidates the previous verify
  });

  it("fails with a counter when new documents cannot be classified (no map)", async () => {
    const { svc, state, listing } = await switched();
    const seen = svc.calls.length;
    await assert.rejects(runDelta(svc.transport, state, listing, null, {}, { ...FAST, since: T0 }), /1 document\(s\) updated since .* have no classification/);
    assert.equal(svc.calls.length, seen);
    assert.equal(state.classifications.length, 6);
  });

  it("dry-run reports the plan, changes no state and makes no request", async () => {
    const { svc, state, listing } = await switched();
    const seen = svc.calls.length;
    const report = await runDelta(svc.transport, state, listing, MAP, {}, { ...FAST, since: T0, dryRun: true });
    assert.equal(report.counts.newlyClassified, 1);
    assert.equal(report.counts.documentsPending, 2);
    assert.equal(report.counts.documentsMoved, 0);
    assert.equal(svc.calls.length, seen);
    assert.equal(state.classifications.length, 6);
    assert.equal(state.verifiedAt, VERIFIED_AT);
  });
});

describe("split-banks purge of the source bank", () => {
  it("refuses to run without a passing verify", async () => {
    const { svc, state } = await copiedAndVerified();
    state.verifiedAt = null;
    const seen = svc.calls.length;
    await assert.rejects(runPurge(svc.transport, state, FAST), /run verify first/);
    assert.equal(svc.calls.length, seen);
  });

  it("dry-run reads and plans but writes nothing", async () => {
    const { svc, state } = await copiedAndVerified();
    seedPurgeMemories(svc);
    const seen = svc.calls.length;
    const report = await runPurge(svc.transport, state, { ...FAST, dryRun: true });
    assert.deepEqual(svc.writes(seen), []);
    assert.equal(report.counts.documentsDeletable, 4);
    assert.equal(report.counts.memoriesToClear, 5);
    assert.equal(state.purge, null);
    assert.equal(svc.bank(SOURCE).docs.size, 6);
  });

  it("follows the safe order and leaves no observation built from a purged document", async () => {
    const { svc, state } = await copiedAndVerified();
    seedPurgeMemories(svc);
    svc.limits.pageCap = 3; // the listing must be walked page by page
    const seen = svc.calls.length;
    const report = await runPurge(svc.transport, state, FAST);

    assert.equal(report.counts.documentsDeleted, 4);
    assert.equal(report.counts.observationsMixed, 2);
    assert.equal(report.counts.observationsPureForeign, 2);
    assert.equal(report.counts.memoriesToClear, 5);
    // Only the source's own documents remain, and its own observations survive.
    assert.deepEqual([...svc.bank(SOURCE).docs.keys()].sort(), ["doc-none-1", "doc-op-1"]);
    assert.deepEqual(svc.bank(SOURCE).observations.map((o) => o.id).sort(), ["o-nosrc", "o-own"]);
    // Own sources of mixed observations were reset for re-consolidation.
    assert.deepEqual([...svc.bank(SOURCE).resets].sort(), ["m-a1", "m-b1", "m-none", "m-op1", "m-op2"]);
    // Order: consolidation off -> observations -> documents -> consolidation back on.
    const writes = svc.writes(seen);
    const at = (predicate) => writes.findIndex(predicate);
    const off = at((c) => c.startsWith("PATCH ") && c.endsWith("/config"));
    const firstObservation = at((c) => c.includes("/observations"));
    const firstDocument = at((c) => c.includes("/documents/"));
    const lastPatch = writes.length - 1 - [...writes].reverse().findIndex((c) => c.startsWith("PATCH "));
    assert.ok(off === 0 && off < firstObservation && firstObservation < firstDocument && firstDocument < lastPatch);
    assert.deepEqual(svc.configPatches, [false, true]);
    assert.equal(svc.bank(SOURCE).config.enable_auto_consolidation, true);
    assert.equal(state.purge.consolidationRestored, true);

    const again = await runPurge(svc.transport, state, FAST);
    assert.equal(again.counts.documentsDeleted, 0);
  });

  it("a failure midway names the disabled consolidation; a repeat resumes and restores the recorded setting", async () => {
    const { svc, state } = await copiedAndVerified();
    seedPurgeMemories(svc);
    svc.failDelete.add("doc-b-1");
    await assert.rejects(runPurge(svc.transport, state, FAST), /may still be disabled \(was true\)/);
    assert.equal(svc.bank(SOURCE).config.enable_auto_consolidation, false);
    assert.equal(state.purge.observationsCleared, true);

    svc.failDelete.clear();
    const seen = svc.calls.length;
    const report = await runPurge(svc.transport, state, FAST);
    assert.equal(svc.calls.slice(seen).some((c) => c.includes("/memories/")), false); // observations are not re-planned
    assert.equal(state.purged.length, 4);
    assert.ok(report.counts.documentsDeleted >= 1);
    assert.equal(svc.bank(SOURCE).config.enable_auto_consolidation, true);
  });
});

describe("split-banks rollback", () => {
  it("copies post-switch documents back with replace and never deletes from the new banks", async () => {
    const { svc, state } = await copiedAndVerified();
    state.verifiedAt = null;
    svc.bank("bank-a").docs.set("doc-a-1", { units: { world: 77, experience: 4 }, textSha256: "sha256-doc-a-1-v2", updatedAt: AFTER_T0 });
    svc.bank("bank-b").docs.set("doc-post-1", { units: { world: 1, experience: 1 }, textSha256: "sha256-doc-post-1", updatedAt: AFTER_T0 });
    const listings = {
      "bank-a": svc.listing("bank-a"),
      "bank-b": svc.listing("bank-b"),
    };
    const seen = svc.calls.length;
    const report = await runRollback(svc.transport, state, listings, { ...FAST, since: T0 });
    assert.equal(report.counts.documentsMovedBack, 2);
    assert.deepEqual(report.documentIds.sort(), ["doc-a-1", "doc-post-1"]);
    assert.equal(svc.bank(SOURCE).docs.get("doc-a-1").units.world, 77);
    assert.ok(svc.bank(SOURCE).docs.has("doc-post-1"));
    assert.ok(svc.calls.slice(seen).some((c) => c === "UPLOAD /v1/default/banks/source-bank/document-transfer?on_conflict=replace"));
    assert.equal(svc.calls.slice(seen).some((c) => c.startsWith("DELETE ")), false);
    assert.equal(svc.bank("bank-a").docs.size, 3);
    assert.equal(svc.bank("bank-b").docs.size, 2);
  });

  it("needs the switch moment, refuses after purge, and dry-run makes no request", async () => {
    const { svc, state } = await copiedAndVerified();
    const listings = { "bank-a": svc.listing("bank-a") };
    await assert.rejects(runRollback(svc.transport, state, listings, FAST), /--since/);
    const seen = svc.calls.length;
    const dry = await runRollback(svc.transport, state, listings, { ...FAST, since: BEFORE_T0, dryRun: true });
    assert.equal(dry.counts.documentsMovedBack, 0);
    assert.equal(svc.calls.length, seen);
    state.purged.push("doc-a-1");
    await assert.rejects(runRollback(svc.transport, state, listings, { ...FAST, since: T0 }), /already purged/);
  });
});

describe("split-banks state and CLI", () => {
  const silent = () => {
    const lines = [];
    return { lines, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } };
  };

  it("state round-trips through the JSON file; an older state file gets the new fields", () => {
    const dir = tmpDir();
    const file = path.join(dir, "state.json");
    const state = newSplitState(SOURCE, T0);
    state.classifications = classifyDocuments(syntheticSource(), MAP, SOURCE);
    state.copied.push("doc-a-1");
    saveSplitState(file, state);
    assert.deepEqual(loadSplitState(file), state);

    const old = path.join(dir, "old.json");
    fs.writeFileSync(old, JSON.stringify({ sourceBank: SOURCE, t0: T0, classifications: [], copied: [], purged: [], rolledBack: {}, lastDeltaAt: null }));
    const loaded = loadSplitState(old);
    assert.deepEqual(loaded.banksCreated, []);
    assert.equal(loaded.purge, null);
  });

  it("joinUrl: the service address is an argument, never hardcoded", () => {
    assert.equal(joinUrl("http://localhost:9999/", "/v1/x"), "http://localhost:9999/v1/x");
    assert.equal(joinUrl("http://localhost:9999", "/v1/x"), "http://localhost:9999/v1/x");
  });

  it("usage error without the required arguments; unknown flags and steps are rejected", async () => {
    const { log } = silent();
    assert.equal(await main(["classify"], log), 2);
    assert.equal(await main(["classify", "--nope", "x"], log), 2);
    assert.equal(await main(["explode", "--api-url", "http://x", "--source-bank", SOURCE, "--state", "s.json"], log), 2);
  });

  it("classify writes the state and prints counters only; --dry-run writes nothing", async () => {
    const dir = tmpDir();
    const documentsFile = path.join(dir, "documents.json");
    const mapFile = path.join(dir, "map.json");
    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(documentsFile, JSON.stringify(syntheticSource()));
    fs.writeFileSync(mapFile, JSON.stringify(MAP));
    const base = ["classify", "--api-url", "http://localhost:9", "--source-bank", SOURCE, "--state", stateFile, "--documents", documentsFile, "--agent-map", mapFile];

    const dry = silent();
    assert.equal(await main([...base, "--dry-run"], dry.log), 0);
    assert.equal(fs.existsSync(stateFile), false);

    const real = silent();
    assert.equal(await main(base, real.log), 0);
    const out = real.lines.join("\n");
    assert.match(out, /"step":"classify"/);
    assert.match(out, /"bank-a":3/);
    assert.doesNotMatch(out, /sha256-doc/);
    assert.equal(loadSplitState(stateFile).classifications.length, 6);
  });

  it("copy through the CLI moves documents and saves the state", async () => {
    const { svc, state } = classified();
    const stateFile = path.join(tmpDir(), "state.json");
    saveSplitState(stateFile, state);
    const { log, lines } = silent();
    const code = await main(
      ["copy", "--api-url", "http://localhost:9", "--source-bank", SOURCE, "--state", stateFile],
      log,
      { transport: svc.transport, sleep: async () => {} },
    );
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(loadSplitState(stateFile).copied.length, 4);
  });

  it("--dry-run is honoured: purge --dry-run sends no write request and leaves the state alone", async () => {
    const { svc, state } = await copiedAndVerified();
    seedPurgeMemories(svc);
    const stateFile = path.join(tmpDir(), "state.json");
    saveSplitState(stateFile, state);
    const before = fs.readFileSync(stateFile, "utf8");
    const seen = svc.calls.length;
    const { log, lines } = silent();
    const code = await main(
      ["purge", "--dry-run", "--api-url", "http://localhost:9", "--source-bank", SOURCE, "--state", stateFile],
      log,
      { transport: svc.transport, sleep: async () => {} },
    );
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(svc.writes(seen), []);
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
    assert.equal(svc.bank(SOURCE).docs.size, 6);
    assert.match(lines.join("\n"), /"step":"purge \(dry-run\)"/);
  });

  it("verify through the CLI takes the source listing and a direct bank -> documents map", async () => {
    const { svc, state, docs } = classified();
    await runCopy(svc.transport, state, {}, FAST);
    const dir = tmpDir();
    const stateFile = path.join(dir, "state.json");
    const documentsFile = path.join(dir, "documents.json");
    const banksFile = path.join(dir, "banks.json");
    saveSplitState(stateFile, state);
    fs.writeFileSync(documentsFile, JSON.stringify(docs));
    fs.writeFileSync(banksFile, JSON.stringify({ "bank-a": svc.listing("bank-a"), "bank-b": svc.listing("bank-b") }));
    const argv = ["verify", "--api-url", "http://localhost:9", "--source-bank", SOURCE, "--state", stateFile, "--documents", documentsFile, "--bank-documents", banksFile];

    const ok = silent();
    assert.equal(await main(argv, ok.log), 0, ok.lines.join("\n"));
    assert.ok(loadSplitState(stateFile).verifiedAt);

    fs.writeFileSync(banksFile, JSON.stringify({ "bank-a": [], "bank-b": svc.listing("bank-b") }));
    const bad = silent();
    assert.equal(await main(argv, bad.log), 1);
    assert.match(bad.lines.join("\n"), /bank-a has 0 document\(s\), expected 3/);
    assert.equal(loadSplitState(stateFile).verifiedAt, null);
  });

  it("a state file of another source bank is rejected", async () => {
    const stateFile = path.join(tmpDir(), "state.json");
    saveSplitState(stateFile, newSplitState("someone-else", T0));
    const { log, lines } = silent();
    const code = await main(["copy", "--api-url", "http://localhost:9", "--source-bank", SOURCE, "--state", stateFile], log, {
      transport: mockService().transport,
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /different source bank/);
  });
});
