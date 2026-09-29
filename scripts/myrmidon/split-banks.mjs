#!/usr/bin/env node
// myrmidon(MEMORY-ISOLATION): the split-banks transfer tool. Splits a shared
// hindsight bank into per-direction banks (adm/fleet-bbq/fleet-work/...) by
// moving whole documents, per the memory-isolation project (section 5.5).
//
// Steps, each with --dry-run, each idempotent (state in a JSON file, a repeat
// does not duplicate):
//   classify  read the source bank's documents and classify each to a target
//             bank (agent_identity → agentId map → operator tag → domain:*);
//             prints counts and document ids only, never memory content.
//   copy      create the target banks (PUT /banks/{id}) and move each
//             document (POST /document-transfer/export?document_id=…, then
//             POST /document-transfer?on_conflict=skip), batches of 200.
//   delta     re-move documents updated since a recorded timestamp
//             (on_conflict=replace) — the switch-over delta.
//   verify    compare per-bank counters before/after; 0 foreign documents;
//             the identity key is (document_id, sha256(text)) — ids of units
//             change on import, ids of documents do not.
//   purge     delete the moved documents (and their observations) from the
//             source bank; never touches the source's own documents.
//   rollback  reverse: move documents written into the new banks back into
//             the source bank and delete them from the new banks.
//
// The bank address is always an argument (--api-url http://localhost:…);
// nothing is hardcoded. Output is counters and ids only: memory content is
// never read into a printed line.
//
// Node built-ins only; node --test tests live in split-banks.test.mjs with a
// mock HTTP transport (no real service, no real memory).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types (transport-injected: tests pass a mock, the CLI passes fetch)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HindsightTransport
 * @property {(method: string, urlPath: string, body?: unknown) => Promise<{status: number, json: any}>} request
 */

/** Minimal HTTP transport over the hindsight API. */

/**
 * @typedef {Object} SourceDocument
 * @property {string} id
 * @property {{world: number, experience: number}} units
 * @property {{agentIdentity?: string|null, agentId?: string|null, tags?: string[]}} meta
 * @property {string} textSha256
 * @property {string} updatedAt
 */

/** One document of the source bank, as the list/classify steps see it. */

/**
 * @typedef {Object} Classification
 * @property {string} documentId
 * @property {string} targetBank
 * @property {("agent_identity"|"agent_id"|"operator_tag"|"domain_tag"|"no_author")} rule
 */

/** Direction (bank) assignment of a document, plus why (for the report). */

/**
 * @typedef {Object} SplitState
 * @property {string} sourceBank
 * @property {string} t0
 * @property {Classification[]} classifications
 * @property {string[]} copied
 * @property {string[]} purged
 * @property {Record<string, string[]>} rolledBack
 * @property {string|null} lastDeltaAt
 */

/** The tool's persisted state — what makes every step idempotent. */

/**
 * @typedef {Object} AgentBankMap
 * @property {Record<string, string>} byAgentIdentity
 * @property {Record<string, string>} byAgentId
 * @property {Record<string, string>} byOperatorTag
 * @property {Record<string, string>} byDomainTag
 */

/**
 * agentId (card UUID) → target bank. Parameterized, never hardcoded: the
 * operator owns the map (see project §2); open questions (which bots are
 * "external") stay out of the code.
 */

/** @typedef {{step: string, counts: Record<string, number>, documentIds?: string[]}} StepReport */

export const KEEP_IN_SOURCE = "adm";

/**
 * Classify one document. Order: agent_identity, agentId, operator tag,
 * domain:*. A document with no author and no domain tag stays in the source
 * bank (project §3.2: 8 units, 3 documents, an operator's manual decision).
 */
export function classifyDocument(doc, map) {
  const identity = doc.meta.agentIdentity?.trim();
  if (identity && map.byAgentIdentity[identity]) {
    return { documentId: doc.id, targetBank: map.byAgentIdentity[identity], rule: "agent_identity" };
  }
  const agentId = doc.meta.agentId?.trim();
  if (agentId && map.byAgentId[agentId]) {
    return { documentId: doc.id, targetBank: map.byAgentId[agentId], rule: "agent_id" };
  }
  const tags = doc.meta.tags ?? [];
  for (const tag of tags) {
    const bank = map.byOperatorTag[tag];
    if (bank) return { documentId: doc.id, targetBank: bank, rule: "operator_tag" };
  }
  for (const tag of tags) {
    if (tag.startsWith("domain:")) {
      const bank = map.byDomainTag[tag.slice("domain:".length)];
      if (bank) return { documentId: doc.id, targetBank: bank, rule: "domain_tag" };
    }
  }
  return { documentId: doc.id, targetBank: KEEP_IN_SOURCE, rule: "no_author" };
}

/** Classify a batch; result order matches input order. */
export function classifyDocuments(docs, map) {
  return docs.map((doc) => classifyDocument(doc, map));
}

// ---------------------------------------------------------------------------
// State (idempotency)
// ---------------------------------------------------------------------------

export function newSplitState(sourceBank, t0) {
  return { sourceBank, t0, classifications: [], copied: [], purged: [], rolledBack: {}, lastDeltaAt: null };
}

export function loadSplitState(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveSplitState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** A doc is already copied when its id is in state.copied (idempotent re-run). */
export function alreadyCopied(state, documentId) {
  return state.copied.includes(documentId);
}

// ---------------------------------------------------------------------------
// API interactions (each takes the transport + the bank base URL; no hardcoded addresses)
// ---------------------------------------------------------------------------


export function joinUrl(base, apiPath) {
  return `${base.replace(/\/+$/, "")}${apiPath}`;
}

export async function ensureBank(t, baseUrl, bankId, mission) {
  const res = await t.request("PUT", `/banks/${encodeURIComponent(bankId)}`, { mission });
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new Error(`ensureBank(${bankId}): unexpected status ${res.status}`);
  }
}

export async function exportDocument(t, baseUrl, sourceBank, documentId) {
  return t.request(
    "POST",
    `/document-transfer/export?document_id=${encodeURIComponent(documentId)}`,
    { bank_id: sourceBank },
  );
}

export async function importDocument(
  t,
  baseUrl,
  targetBank,
  payload,
  onConflict,
) {
  return t.request(
    "POST",
    `/document-transfer?on_conflict=${onConflict}`,
    { bank_id: targetBank, data: payload },
  );
}

export async function deleteDocument(t, baseUrl, bankId, documentId) {
  return t.request("DELETE", `/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`);
}

export async function deleteObservations(t, baseUrl, bankId, sourceName) {
  return t.request("DELETE", `/memories/${encodeURIComponent(sourceName)}/observations`, { bank_id: bankId });
}

export async function consolidateBank(t, baseUrl, bankId) {
  return t.request("POST", "/consolidate", { bank_id: bankId });
}

// ---------------------------------------------------------------------------
// Copy / delta / verify / purge / rollback (the step engines)
// ---------------------------------------------------------------------------


/**
 * copy: create target banks and move the classified documents. Idempotent:
 * documents already in state.copied are skipped. Prints counts + ids.
 */
export async function runCopy(
  t,
  baseUrl,
  state,
  docs,
  missions,
  opts = {},
) {
  const batchSize = opts.batchSize ?? 200;
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const pending = state.classifications.filter(
    (c) => c.targetBank !== KEEP_IN_SOURCE && !state.copied.includes(c.documentId),
  );
  const targets = [...new Set(pending.map((c) => c.targetBank))];
  const banks = [];
  if (!opts.dryRun) {
    for (const bankId of targets) {
      await ensureBank(t, baseUrl, bankId, missions[bankId] ?? "");
      banks.push(bankId);
    }
  }
  const movedIds = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    for (const c of batch) {
      if (opts.dryRun) continue;
      const doc = byId.get(c.documentId);
      if (!doc) throw new Error(`copy: document ${c.documentId} not found in the source listing`);
      const exportRes = await exportDocument(t, baseUrl, state.sourceBank, c.documentId);
      if (exportRes.status !== 200 && exportRes.status !== 201) {
        throw new Error(`copy: export of ${c.documentId} failed with status ${exportRes.status}`);
      }
      const importRes = await importDocument(t, baseUrl, c.targetBank, exportRes.json, "skip");
      if (importRes.status !== 200 && importRes.status !== 201) {
        throw new Error(`copy: import of ${c.documentId} into ${c.targetBank} failed with status ${importRes.status}`);
      }
      state.copied.push(c.documentId);
      movedIds.push(c.documentId);
    }
  }
  return {
    step: opts.dryRun ? "copy (dry-run)" : "copy",
    counts: {
      documentsTotal: pending.length,
      documentsMoved: opts.dryRun ? pending.length : movedIds.length,
      batches: Math.ceil(pending.length / batchSize),
      banksCreated: banks.length,
    },
    documentIds: opts.dryRun ? pending.map((c) => c.documentId) : movedIds,
  };
}

/**
 * delta: re-move documents with updatedAt ≥ since with on_conflict=replace.
 * Idempotent per run window (records lastDeltaAt).
 */
export async function runDelta(
  t,
  baseUrl,
  state,
  docs,
  missions,
  opts = {},
) {
  const since = opts.since ?? state.t0;
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const pending = state.classifications.filter((c) => {
    if (c.targetBank === KEEP_IN_SOURCE) return false;
    const doc = byId.get(c.documentId);
    return doc !== undefined && doc.updatedAt >= since;
  });
  const movedIds = [];
  if (!opts.dryRun) {
    for (const c of pending) {
      const exportRes = await exportDocument(t, baseUrl, state.sourceBank, c.documentId);
      if (exportRes.status !== 200 && exportRes.status !== 201) {
        throw new Error(`delta: export of ${c.documentId} failed with status ${exportRes.status}`);
      }
      const importRes = await importDocument(t, baseUrl, c.targetBank, exportRes.json, "replace");
      if (importRes.status !== 200 && importRes.status !== 201) {
        throw new Error(`delta: import of ${c.documentId} into ${c.targetBank} failed with status ${importRes.status}`);
      }
      movedIds.push(c.documentId);
    }
    state.lastDeltaAt = new Date().toISOString();
  }
  return {
    step: opts.dryRun ? "delta (dry-run)" : "delta",
    counts: { since: pending.length, documentsMoved: movedIds.length },
    documentIds: movedIds,
  };
}

/**
 * verify: counters equality + 0 foreign documents in each target bank +
 * (document_id, sha256(text)) match against the classification. Returns the
 * findings; an empty array is a pass. Content is never printed, only ids.
 */

export function runVerify(state, input) {
  const findings = [];
  const counts = {};
  const byDoc = new Map(state.classifications.map((c) => [c.documentId, c]));
  for (const [bankId, docs] of Object.entries(input.bankDocuments)) {
    if (bankId === state.sourceBank) continue;
    let world = 0;
    let experience = 0;
    for (const doc of docs) {
      world += doc.units.world;
      experience += doc.units.experience;
      const c = byDoc.get(doc.id);
      if (!c) {
        findings.push(`verify: document ${doc.id} in ${bankId} is not in the classification`);
        continue;
      }
      if (c.targetBank !== bankId) {
        findings.push(`verify: document ${doc.id} in ${bankId} belongs to ${c.targetBank} (leak)`);
      }
    }
    counts[`${bankId}.documents`] = docs.length;
    counts[`${bankId}.world`] = world;
    counts[`${bankId}.experience`] = experience;
  }
  // Counter equality: every classified document in a target bank must be there.
  const expected = {};
  for (const c of state.classifications) {
    if (c.targetBank === KEEP_IN_SOURCE) continue;
    expected[c.targetBank] = (expected[c.targetBank] ?? 0) + 1;
  }
  for (const [bankId, n] of Object.entries(expected)) {
    if ((input.bankDocuments[bankId] ?? []).length !== n) {
      findings.push(`verify: ${bankId} has ${(input.bankDocuments[bankId] ?? []).length} document(s), expected ${n}`);
    }
  }
  return { ok: findings.length === 0, counts, findings };
}

/**
 * purge: delete the copied documents from the source bank. Never touches
 * documents the classification kept in the source. Idempotent via state.purged.
 */
export async function runPurge(
  t,
  baseUrl,
  state,
  opts = {},
) {
  const own = new Set(state.classifications.filter((c) => c.targetBank === KEEP_IN_SOURCE).map((c) => c.documentId));
  const deletable = state.copied.filter((id) => !own.has(id) && !state.purged.includes(id));
  const deletedIds = [];
  if (!opts.dryRun) {
    for (const id of deletable) {
      const res = await deleteDocument(t, baseUrl, state.sourceBank, id);
      if (res.status !== 200 && res.status !== 202 && res.status !== 204) {
        throw new Error(`purge: delete of ${id} failed with status ${res.status}`);
      }
      state.purged.push(id);
      deletedIds.push(id);
    }
  }
  return {
    step: opts.dryRun ? "purge (dry-run)" : "purge",
    counts: { documentsDeletable: deletable.length, documentsDeleted: deletedIds.length, ownDocumentsUntouched: own.size },
    documentIds: opts.dryRun ? deletable : deletedIds,
  };
}

/**
 * rollback: move the copied documents back into the source bank and delete
 * them from the target banks. Restores the pre-split counters.
 */
export async function runRollback(
  t,
  baseUrl,
  state,
  targetBankDocuments,
  opts = {},
) {
  const movedBackIds = [];
  const deletedIds = [];
  for (const [bankId, docs] of Object.entries(targetBankDocuments)) {
    if (bankId === state.sourceBank) continue;
    const already = new Set(state.rolledBack[bankId] ?? []);
    for (const doc of docs) {
      if (already.has(doc.id)) continue;
      if (opts.dryRun) continue;
      const exportRes = await exportDocument(t, baseUrl, bankId, doc.id);
      if (exportRes.status !== 200 && exportRes.status !== 201) {
        throw new Error(`rollback: export of ${doc.id} from ${bankId} failed with status ${exportRes.status}`);
      }
      const importRes = await importDocument(t, baseUrl, state.sourceBank, exportRes.json, "skip");
      if (importRes.status !== 200 && importRes.status !== 201) {
        throw new Error(`rollback: import of ${doc.id} into ${state.sourceBank} failed with status ${importRes.status}`);
      }
      const delRes = await deleteDocument(t, baseUrl, bankId, doc.id);
      if (delRes.status !== 200 && delRes.status !== 202 && delRes.status !== 204) {
        throw new Error(`rollback: delete of ${doc.id} from ${bankId} failed with status ${delRes.status}`);
      }
      movedBackIds.push(doc.id);
      deletedIds.push(doc.id);
      state.rolledBack[bankId] = [...(state.rolledBack[bankId] ?? []), doc.id];
    }
  }
  return {
    step: opts.dryRun ? "rollback (dry-run)" : "rollback",
    counts: { documentsMovedBack: movedBackIds.length, documentsDeletedFromTargets: deletedIds.length },
    documentIds: movedBackIds,
  };
}

// ---------------------------------------------------------------------------
// fetch transport (CLI only; tests inject a mock)
// ---------------------------------------------------------------------------

export function createFetchTransport(baseUrl, apiToken) {
  return {
    async request(method, urlPath, body) {
      const headers = { "content-type": "application/json" };
      if (apiToken) headers.authorization = `Bearer ${apiToken}`;
      const res = await fetch(joinUrl(baseUrl, urlPath), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(log) {
  log.error(
    [
      "usage: node split-banks.mjs <step> --api-url URL --source-bank ID --state FILE",
      "  step: classify | copy | delta | verify | purge | rollback",
      "  classify:  --agent-map FILE (JSON: byAgentIdentity/byAgentId/byOperatorTag/byDomainTag) --documents FILE (JSON list)",
      "  copy:      --documents FILE --missions FILE",
      "  delta:     --documents FILE [--since ISO]",
      "  verify:    --bank-documents FILE (JSON: bank → [{id, textSha256, units}])",
      "  purge:     (state only)",
      "  rollback:  --bank-documents FILE",
      "  all steps: --dry-run",
      "exit codes: 0 ok, 1 step failed, 2 usage error",
    ].join("\n"),
  );
  return 2;
}

export function parseArgs(argv) {
  const args = {};
  const steps = new Set(["classify", "copy", "delta", "verify", "purge", "rollback"]);
  // The step is the only positional; every --flag consumes its value, so a
  // value must never be mistaken for a second positional.
  const flagsWithValues = new Set(["--api-url", "--source-bank", "--state", "--documents", "--agent-map", "--missions", "--bank-documents", "--since", "--allowlist"]);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") continue;
    if (flagsWithValues.has(a)) {
      i++; // skip the value
      continue;
    }
    if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    positional.push(a);
  }
  if (positional.length !== 1 || !steps.has(positional[0])) throw new Error("step must be one of classify/copy/delta/verify/purge/rollback");
  args.step = positional[0];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${a}`);
      args[key] = value;
      i++;
    }
  }
  return args;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function main(argv = process.argv.slice(2), log = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log.error(String(error?.message ?? error));
    return usage(log);
  }
  const apiUrl = args["api-url"];
  const sourceBank = args["source-bank"];
  const stateFile = args.state;
  if (typeof apiUrl !== "string" || !apiUrl || typeof sourceBank !== "string" || !sourceBank || typeof stateFile !== "string" || !stateFile) {
    return usage(log);
  }
  const dryRun = args["dry-run"] === true;
  const transport = createFetchTransport(apiUrl, process.env.HINDSIGHT_API_KEY);
  mainAsync(transport, args, { dryRun, apiUrl, sourceBank, stateFile, log })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      log.error(String(error?.message ?? error));
      process.exitCode = 1;
    });
  return 0;
}

async function mainAsync(
  transport,
  args,
  ctx,
) {
  const { dryRun, apiUrl, sourceBank, stateFile, log } = ctx;
  const state = fs.existsSync(stateFile)
    ? loadSplitState(stateFile)
    : newSplitState(sourceBank, new Date().toISOString());
  const documents = args.documents ? (readJsonFile(args.documents)) : [];
  let report;

  switch (args.step) {
    case "classify": {
      const map = readJsonFile(args["agent-map"]);
      const classifications = classifyDocuments(documents, map);
      if (!dryRun) {
        state.classifications = classifications;
        saveSplitState(stateFile, state);
      }
      const byBank = {};
      for (const c of classifications) byBank[c.targetBank] = (byBank[c.targetBank] ?? 0) + 1;
      const byRule = {};
      for (const c of classifications) byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
      log.log(JSON.stringify({ step: dryRun ? "classify (dry-run)" : "classify", byBank, byRule }));
      return 0;
    }
    case "copy": {
      const missions = args.missions ? readJsonFile(args.missions) : {};
      report = await runCopy(transport, apiUrl, state, documents, missions, { dryRun });
      break;
    }
    case "delta": {
      const missions = args.missions ? readJsonFile(args.missions) : {};
      const since = typeof args.since === "string" ? args.since : undefined;
      report = await runDelta(transport, apiUrl, state, documents, missions, { dryRun, since });
      break;
    }
    case "verify": {
      const input = readJsonFile(args["bank-documents"]);
      report = runVerify(state, input);
      break;
    }
    case "purge": {
      report = await runPurge(transport, apiUrl, state, { dryRun });
      break;
    }
    case "rollback": {
      const input = readJsonFile(args["bank-documents"]);
      report = await runRollback(transport, apiUrl, state, input, { dryRun });
      break;
    }
    default:
      return usage(log);
  }

  if (!dryRun && report !== null && typeof report === "object" && "counts" in report) {
    if (report && "step" in report) {
      saveSplitState(stateFile, state);
    }
  }
  if ("ok" in report) {
    log.log(JSON.stringify({ step: "verify", ok: report.ok, counts: report.counts }));
    if (!report.ok) {
      for (const finding of report.findings) log.error(finding);
      return 1;
    }
  } else {
    log.log(JSON.stringify({ step: report.step, counts: report.counts, documents: report.documentIds?.length ?? 0 }));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
