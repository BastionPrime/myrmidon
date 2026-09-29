import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  KEEP_IN_SOURCE,
  classifyDocument,
  classifyDocuments,
  joinUrl,
  loadSplitState,
  main,
  newSplitState,
  runCopy,
  runDelta,
  runPurge,
  runRollback,
  runVerify,
  saveSplitState,
} from "./split-banks.mjs";

// Synthetic data only: fake ids, fake hashes, a mock transport over an
// in-memory "bank service". No real addresses (the base URL is a placeholder
// the transport never dereferences), no memory content anywhere.

const T0 = "2026-09-29T00:00:00.000Z";

/** The operator's agent → bank map (parameterized, mirrors project §2). */
const MAP = {
  byAgentIdentity: {
    "agent-bbq-1": "fleet-bbq",
    "agent-work-1": "fleet-work",
  },
  byAgentId: {
    "11111111-1111-1111-1111-111111111111": "fleet-bbq",
    "22222222-2222-2222-2222-222222222222": "fleet-work",
  },
  byOperatorTag: { "от-adm2": "adm" },
  byDomainTag: { bbq: "fleet-bbq", work: "fleet-work" },
};

function doc(id, overrides = {}) {
  return {
    id,
    units: { world: 2, experience: 1 },
    meta: {},
    textSha256: `sha256-${id}`,
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...overrides,
  };
}

/** Documents of three authors + mixed-observation sources + no-author records. */
function syntheticSource() {
  return [
    // bbq author by identity (hermes_local writer)
    doc("doc-bbq-1", { meta: { agentIdentity: "agent-bbq-1" }, units: { world: 10, experience: 4 } }),
    // bbq author by agentId (Paperclip plugin writer)
    doc("doc-bbq-2", { meta: { agentId: "11111111-1111-1111-1111-111111111111" }, units: { world: 6, experience: 2 } }),
    // work author by identity
    doc("doc-work-1", { meta: { agentIdentity: "agent-work-1" }, units: { world: 3, experience: 3 } }),
    // operator tag → stays adm (operator's own)
    doc("doc-op-1", { meta: { tags: ["от-adm2"] }, units: { world: 1, experience: 0 } }),
    // domain:bbq tag → fleet-bbq
    doc("doc-domain-1", { meta: { tags: ["domain:bbq"] }, units: { world: 5, experience: 5 } }),
    // no author, no domain → stays in the source bank (operator's manual call)
    doc("doc-none-1", { units: { world: 1, experience: 1 } }),
  ];
}

/** In-memory hindsight API: banks, documents; call log. */
function mockService() {
  const banks = new Map(); // bankId → Map(documentId → {units, textSha256})
  const calls = [];
  const bank = (id) => {
    if (!banks.has(id)) banks.set(id, new Map());
    return banks.get(id);
  };
  bank("adm"); // the source bank exists
  const seed = (bankId, docs) => {
    for (const d of docs) bank(bankId).set(d.id, { units: d.units, textSha256: d.textSha256 });
  };
  const transport = {
    async request(method, urlPath, body) {
      calls.push(`${method} ${urlPath}`);
      if (method === "PUT" && urlPath.startsWith("/banks/")) {
        const id = decodeURIComponent(urlPath.slice("/banks/".length));
        bank(id);
        return { status: 201, json: { ok: true } };
      }
      if (method === "POST" && urlPath.startsWith("/document-transfer/export")) {
        const documentId = new URLSearchParams(urlPath.split("?")[1]).get("document_id");
        const src = body.bank_id;
        const found = banks.get(src)?.get(documentId);
        if (!found) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: { document_id: documentId, units: found.units, text_sha256: found.textSha256 } };
      }
      if (method === "POST" && urlPath.startsWith("/document-transfer?")) {
        const onConflict = new URLSearchParams(urlPath.split("?")[1]).get("on_conflict");
        const target = body.bank_id;
        const docId = body.data.document_id;
        const existing = bank(target).get(docId);
        if (existing && onConflict === "skip") {
          return { status: 200, json: { imported: 0, skipped: 1 } };
        }
        bank(target).set(docId, { units: body.data.units, textSha256: body.data.text_sha256 });
        return { status: 200, json: { imported: 1, skipped: 0 } };
      }
      if (method === "DELETE" && urlPath.includes("/documents/")) {
        const parts = urlPath.split("/");
        const bankId = decodeURIComponent(parts[2]);
        const documentId = decodeURIComponent(parts[4]);
        if (!banks.get(bankId)?.delete(documentId)) {
          return { status: 404, json: { error: "not found" } };
        }
        return { status: 204, json: null };
      }
      return { status: 404, json: { error: `unhandled ${method} ${urlPath}` } };
    },
  };
  return { banks, calls, transport, seed, counts: (id) => bank(id).size };
}

function stateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "split-banks-")), "state.json");
}

describe("split-banks classification", () => {
  const docs = syntheticSource();

  it("classifies by agent_identity first, then agentId, operator tag, domain tag; no author stays", () => {
    assert.deepEqual(classifyDocument(docs[0], MAP), { documentId: "doc-bbq-1", targetBank: "fleet-bbq", rule: "agent_identity" });
    assert.deepEqual(classifyDocument(docs[1], MAP), { documentId: "doc-bbq-2", targetBank: "fleet-bbq", rule: "agent_id" });
    assert.deepEqual(classifyDocument(docs[2], MAP), { documentId: "doc-work-1", targetBank: "fleet-work", rule: "agent_identity" });
    assert.deepEqual(classifyDocument(docs[3], MAP), { documentId: "doc-op-1", targetBank: "adm", rule: "operator_tag" });
    assert.deepEqual(classifyDocument(docs[4], MAP), { documentId: "doc-domain-1", targetBank: "fleet-bbq", rule: "domain_tag" });
    assert.deepEqual(classifyDocument(docs[5], MAP), { documentId: "doc-none-1", targetBank: KEEP_IN_SOURCE, rule: "no_author" });
  });

  it("classifyDocuments keeps input order and count", () => {
    const list = classifyDocuments(docs, MAP);
    assert.equal(list.length, docs.length);
    assert.deepEqual(list.map((c) => c.documentId), docs.map((d) => d.id));
  });
});

describe("split-banks copy/verify (counters equality, 0 leaks)", () => {
  it("copies classified documents to their banks, idempotently, and verify passes with 0 findings", async () => {
    const svc = mockService();
    const docs = syntheticSource();
    svc.seed("adm", docs);
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(docs, MAP);

    const first = await runCopy(svc.transport, "http://localhost:9", state, docs, {}, {});
    assert.equal(first.counts.documentsMoved, 4); // 2 bbq + 1 work + 1 domain
    assert.equal(svc.counts("fleet-bbq"), 3);
    assert.equal(svc.counts("fleet-work"), 1);

    // Idempotent: a second run moves nothing (state.copied).
    const second = await runCopy(svc.transport, "http://localhost:9", state, docs, {}, {});
    assert.equal(second.counts.documentsMoved, 0);
    assert.equal(svc.counts("fleet-bbq"), 3);

    // The source bank still holds everything until purge.
    assert.equal(svc.counts("adm"), 6);

    // verify: per-bank counters equality + 0 foreign documents.
    const input = {
      bankDocuments: {
        "fleet-bbq": [...svc.banks.get("fleet-bbq")].map(([id, v]) => ({ id, textSha256: v.textSha256, units: v.units })),
        "fleet-work": [...svc.banks.get("fleet-work")].map(([id, v]) => ({ id, textSha256: v.textSha256, units: v.units })),
      },
    };
    const result = runVerify(state, input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
    assert.equal(result.counts["fleet-bbq.documents"], 3);
    assert.equal(result.counts["fleet-bbq.world"], 21);
    assert.equal(result.counts["fleet-bbq.experience"], 11);
    assert.equal(result.counts["fleet-work.world"], 3);
  });

  it("verify flags a leak: a document sitting in the wrong bank", () => {
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(syntheticSource(), MAP);
    const result = runVerify(state, {
      bankDocuments: { "fleet-work": [{ id: "doc-bbq-1", textSha256: "x", units: { world: 1, experience: 1 } }] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.includes("doc-bbq-1") && f.includes("leak")));
  });

  it("verify flags missing documents: counters must be equal, not close", () => {
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(syntheticSource(), MAP);
    const result = runVerify(state, {
      bankDocuments: {
        "fleet-bbq": [{ id: "doc-bbq-1", textSha256: "x", units: { world: 1, experience: 1 } }],
        "fleet-work": [],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.includes("fleet-bbq") && f.includes("expected 3")));
    assert.ok(result.findings.some((f) => f.includes("fleet-work")));
  });
});

describe("split-banks delta after T0", () => {
  it("re-moves only documents updated at/after the threshold, with on_conflict=replace", async () => {
    const svc = mockService();
    const docs = syntheticSource();
    // One bbq document was updated after T0 (a live bot kept writing to adm).
    const updated = { ...docs[0], updatedAt: "2026-09-29T12:00:00.000Z" };
    svc.seed("adm", docs);
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(docs, MAP);
    await runCopy(svc.transport, "http://localhost:9", state, docs, {}, {});

    svc.banks.get("adm").set("doc-bbq-1", { units: { world: 99, experience: 99 }, textSha256: "sha256-doc-bbq-1" });

    const report = await runDelta(svc.transport, "http://localhost:9", state, [updated], {}, { since: T0 });
    assert.equal(report.counts.since, 1);
    assert.equal(report.counts.documentsMoved, 1);
    const after = svc.banks.get("fleet-bbq").get("doc-bbq-1");
    assert.equal(after.units.world, 99); // replaced, not skipped
    assert.ok(svc.calls.some((c) => c.includes("on_conflict=replace")));
  });

  it("dry-run moves nothing and makes no HTTP calls at all", async () => {
    const svc = mockService();
    const docs = syntheticSource();
    svc.seed("adm", docs);
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(docs, MAP);
    const report = await runDelta(svc.transport, "http://localhost:9", state, docs, {}, { dryRun: true, since: T0 });
    assert.equal(report.counts.documentsMoved, 0);
    assert.deepEqual(report.documentIds, []);
    assert.deepEqual(svc.calls, []);
  });
});

describe("split-banks purge and rollback", () => {
  it("purge deletes only the copied documents, never the source's own; idempotent", async () => {
    const svc = mockService();
    const docs = syntheticSource();
    svc.seed("adm", docs);
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(docs, MAP);
    await runCopy(svc.transport, "http://localhost:9", state, docs, {}, {});

    const report = await runPurge(svc.transport, "http://localhost:9", state, {});
    assert.equal(report.counts.documentsDeleted, 4);
    // The source keeps its own: operator-tagged, no-author documents.
    const remaining = [...svc.banks.get("adm").keys()].sort();
    assert.deepEqual(remaining, ["doc-none-1", "doc-op-1"]);

    const again = await runPurge(svc.transport, "http://localhost:9", state, {});
    assert.equal(again.counts.documentsDeleted, 0);
    assert.equal(svc.counts("adm"), 2);
  });

  it("rollback returns the counters: documents go back to adm and vanish from the targets", async () => {
    const svc = mockService();
    const docs = syntheticSource();
    svc.seed("adm", docs);
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(docs, MAP);
    await runCopy(svc.transport, "http://localhost:9", state, docs, {}, {});

    const targets = {
      "fleet-bbq": [...svc.banks.get("fleet-bbq")].map(([id, v]) => ({ id, textSha256: v.textSha256 })),
      "fleet-work": [...svc.banks.get("fleet-work")].map(([id, v]) => ({ id, textSha256: v.textSha256 })),
    };
    const report = await runRollback(svc.transport, "http://localhost:9", state, targets, {});
    assert.equal(report.counts.documentsMovedBack, 4);
    assert.equal(svc.counts("adm"), 6); // the pre-split counter
    assert.equal(svc.counts("fleet-bbq"), 0);
    assert.equal(svc.counts("fleet-work"), 0);

    // Idempotent: nothing left to roll back.
    const again = await runRollback(svc.transport, "http://localhost:9", state, targets, {});
    assert.equal(again.counts.documentsMovedBack, 0);
  });
});

describe("split-banks state and CLI", () => {
  it("state round-trips through the JSON file (idempotency across runs)", () => {
    const file = stateFile();
    const state = newSplitState("adm", T0);
    state.classifications = classifyDocuments(syntheticSource(), MAP);
    state.copied.push("doc-bbq-1");
    saveSplitState(file, state);
    assert.deepEqual(loadSplitState(file), state);
  });

  it("joinUrl: the bank address is an argument, never hardcoded", () => {
    assert.equal(joinUrl("http://localhost:9999/", "/banks/x"), "http://localhost:9999/banks/x");
    assert.equal(joinUrl("http://localhost:9999", "/banks/x"), "http://localhost:9999/banks/x");
  });

  it("CLI: usage error without the required arguments; classify writes state and prints counts only", async () => {
    const lines = [];
    const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    assert.equal(main(["classify"], log), 2);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-banks-cli-"));
    const documentsFile = path.join(dir, "documents.json");
    const mapFile = path.join(dir, "map.json");
    const file = path.join(dir, "state.json");
    fs.writeFileSync(documentsFile, JSON.stringify(syntheticSource()));
    fs.writeFileSync(mapFile, JSON.stringify(MAP));
    await new Promise((resolve) => {
      main(
        ["classify", "--api-url", "http://localhost:9", "--source-bank", "adm", "--state", file, "--documents", documentsFile, "--agent-map", mapFile],
        log,
      );
      setTimeout(resolve, 100);
    });
    const out = lines.join("\n");
    assert.match(out, /"step":"classify"/);
    assert.match(out, /"fleet-bbq":3/);
    assert.doesNotMatch(out, /sha256-doc/); // no document hashes/content in the print
    const state = loadSplitState(file);
    assert.equal(state.classifications.length, 6);
    assert.equal(state.sourceBank, "adm");
  });
});
