#!/usr/bin/env node
// myrmidon(MEMORY-ISOLATION): the split-banks transfer tool. Splits one shared
// hindsight bank (the "source bank") into per-direction banks by moving whole
// documents through the hindsight document-transfer API.
//
// Steps, each with --dry-run, each idempotent (state lives in a JSON file, a
// repeat does not duplicate):
//   classify  classify each listed document to a target bank
//             (agent_identity -> agentId map -> operator tag -> domain:* tag);
//             a document with no author stays in the source bank.
//   copy      create the target banks (PUT /banks/{id}) and move the classified
//             documents: export (async operation) -> download the archive ->
//             import into the target bank (multipart, on_conflict=skip). The
//             import result must account for every requested document.
//   delta     re-move documents updated since a timestamp (on_conflict=replace);
//             documents that appeared after classify are classified first (or the
//             step fails with a counter). Moved ids join the copied set.
//   verify    compare each target bank's listing with the source listing:
//             document counts, world/experience sums, and the (id, textSha256)
//             pair per document; 0 foreign documents. Purge requires a pass.
//   purge     clean the source bank: disable auto-consolidation, clear the
//             observations (own sources for mixed ones, one foreign source for
//             purely foreign ones), delete the moved documents, restore
//             auto-consolidation. The source's own documents are never touched.
//   rollback  copy documents written into the target banks since the switch
//             moment back into the source bank (on_conflict=replace). It never
//             deletes anything from the target banks, and it refuses after purge.
//
// The service address is always an argument (--api-url); nothing is hardcoded.
// Output is counters and document ids only: memory content is never printed.
//
// Node built-ins only; node --test tests live in split-banks.test.mjs with an
// in-memory mock of the service API (no real service, no real memory).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_PREFIX = "/v1/default";
const DEFAULT_BATCH_SIZE = 200;
// Document ids travel in the export query string; keep each request line well
// below common server limits (16 KB) regardless of id length.
const MAX_QUERY_CHARS = 8000;
const PAGE_SIZE = 500;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const CHECKPOINT_EVERY = 50;

// ---------------------------------------------------------------------------
// Types (transport-injected: tests pass a mock, the CLI passes fetch)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HindsightTransport
 * @property {(method: string, urlPath: string, body?: unknown) => Promise<{status: number, json: any}>} request
 *   JSON request against the service; urlPath starts with /v1/default.
 * @property {(urlPath: string, file: {fileName: string, data: Uint8Array}) => Promise<{status: number, json: any}>} upload
 *   multipart POST with the archive in the form field "file".
 * @property {(location: string) => Promise<{status: number, data: Uint8Array}>} download
 *   fetch an export archive; location is a relative API path or an absolute
 *   (presigned) URL.
 */

/**
 * @typedef {Object} SourceDocument
 * @property {string} id
 * @property {{world: number, experience: number}} units
 * @property {{agentIdentity?: string|null, agentId?: string|null, tags?: string[]}} meta
 * @property {string} textSha256
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Classification
 * @property {string} documentId
 * @property {string} targetBank
 * @property {("agent_identity"|"agent_id"|"operator_tag"|"domain_tag"|"no_author")} rule
 */

/**
 * @typedef {Object} SplitState
 * @property {string} sourceBank
 * @property {string} t0
 * @property {Classification[]} classifications
 * @property {string[]} copied      ids already moved to their target bank (copy and delta)
 * @property {string[]} purged      ids already deleted from the source bank
 * @property {string[]} banksCreated
 * @property {string|null} lastDeltaAt
 * @property {string|null} verifiedAt  set by a passing verify, cleared by any later move
 * @property {null|{consolidationBefore: boolean, observationsCleared: boolean, consolidationRestored: boolean}} purge
 */

/**
 * @typedef {Object} AgentBankMap
 * @property {Record<string, string>} byAgentIdentity
 * @property {Record<string, string>} byAgentId
 * @property {Record<string, string>} byOperatorTag
 * @property {Record<string, string>} byDomainTag
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function lookup(table, key) {
  // The tables come from a JSON file; never resolve keys through the prototype.
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Classify one document. Order: agent_identity, agentId, operator tag,
 * domain:*. A document with no author and no domain tag stays in the source
 * bank (an operator's manual decision).
 * @param {SourceDocument} doc
 * @param {AgentBankMap} map
 * @param {string} sourceBank
 * @returns {Classification}
 */
export function classifyDocument(doc, map, sourceBank) {
  const identity = doc.meta?.agentIdentity?.trim();
  if (identity) {
    const bank = lookup(map.byAgentIdentity, identity);
    if (bank) return { documentId: doc.id, targetBank: bank, rule: "agent_identity" };
  }
  const agentId = doc.meta?.agentId?.trim();
  if (agentId) {
    const bank = lookup(map.byAgentId, agentId);
    if (bank) return { documentId: doc.id, targetBank: bank, rule: "agent_id" };
  }
  const tags = doc.meta?.tags ?? [];
  for (const tag of tags) {
    const bank = lookup(map.byOperatorTag, tag);
    if (bank) return { documentId: doc.id, targetBank: bank, rule: "operator_tag" };
  }
  for (const tag of tags) {
    if (tag.startsWith("domain:")) {
      const bank = lookup(map.byDomainTag, tag.slice("domain:".length));
      if (bank) return { documentId: doc.id, targetBank: bank, rule: "domain_tag" };
    }
  }
  return { documentId: doc.id, targetBank: sourceBank, rule: "no_author" };
}

/** Classify a batch; result order matches input order. */
export function classifyDocuments(docs, map, sourceBank) {
  return docs.map((doc) => classifyDocument(doc, map, sourceBank));
}

// ---------------------------------------------------------------------------
// State (idempotency)
// ---------------------------------------------------------------------------

/** @returns {SplitState} */
export function newSplitState(sourceBank, t0) {
  return {
    sourceBank,
    t0,
    classifications: [],
    copied: [],
    purged: [],
    banksCreated: [],
    lastDeltaAt: null,
    verifiedAt: null,
    purge: null,
  };
}

export function loadSplitState(file) {
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  // Fill fields a state file written by an older revision does not have.
  return { ...newSplitState(saved.sourceBank, saved.t0), ...saved };
}

export function saveSplitState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Any move invalidates a previous verify and any finished observation clearing. */
function invalidateAfterMove(state) {
  state.verifiedAt = null;
  if (state.purge) state.purge.observationsCleared = false;
}

// ---------------------------------------------------------------------------
// API interactions (each takes the transport; no hardcoded addresses)
// ---------------------------------------------------------------------------

export function joinUrl(base, apiPath) {
  return `${base.replace(/\/+$/, "")}${apiPath}`;
}

export function bankPath(bankId, rest = "") {
  return `${API_PREFIX}/banks/${encodeURIComponent(bankId)}${rest}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (value) => (Number.isFinite(value) ? value : 0);

async function requestOk(t, method, urlPath, body, okStatuses, what) {
  const res = await t.request(method, urlPath, body);
  if (!okStatuses.includes(res.status)) throw new Error(`${what}: unexpected status ${res.status}`);
  return res;
}

/** Split ids into batches by count and by the length of the export query string. */
export function makeBatches(ids, maxCount = DEFAULT_BATCH_SIZE, maxQueryChars = MAX_QUERY_CHARS) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const id of ids) {
    const cost = "document_id=".length + encodeURIComponent(id).length + 1;
    if (current.length > 0 && (current.length >= maxCount || chars + cost > maxQueryChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(id);
    chars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Poll an asynchronous operation until it completes; returns its result_metadata. */
export async function waitOperation(t, bankId, operationId, opts = {}) {
  const wait = opts.sleep ?? sleep;
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? POLL_TIMEOUT_MS);
  for (;;) {
    const res = await t.request("GET", bankPath(bankId, `/operations/${encodeURIComponent(operationId)}`));
    if (res.status !== 200) throw new Error(`operation ${operationId}: status poll returned ${res.status}`);
    const status = res.json?.status;
    if (status === "completed") return res.json?.result_metadata ?? {};
    // The service's error text is never echoed: it can quote stored content.
    if (status === "failed" || status === "cancelled" || status === "not_found") {
      throw new Error(`operation ${operationId} ended as ${status}`);
    }
    if (Date.now() >= deadline) throw new Error(`operation ${operationId} is still ${status} after the timeout`);
    await wait(interval);
  }
}

function downloadLocation(meta) {
  if (typeof meta.download_url === "string" && meta.download_url) return meta.download_url;
  if (typeof meta.storage_key === "string" && meta.storage_key) {
    return `${API_PREFIX}/files/download/${meta.storage_key.split("/").map(encodeURIComponent).join("/")}`;
  }
  return null;
}

/**
 * Move one batch of documents between banks: export (async) -> download the
 * archive -> import (async). The archive is opaque bytes here. The export omits
 * unknown ids silently, so the import must account for every requested id.
 */
export async function transferDocuments(t, fromBank, toBank, ids, onConflict, opts = {}) {
  const query = ids.map((id) => `document_id=${encodeURIComponent(id)}`).join("&");
  const submitted = await requestOk(
    t,
    "POST",
    bankPath(fromBank, `/document-transfer/export?${query}`),
    undefined,
    [200, 202],
    "export",
  );
  const exportOp = submitted.json?.operation_id;
  if (!exportOp) throw new Error("export: the response carries no operation_id");
  const exported = await waitOperation(t, fromBank, exportOp, opts);
  const location = downloadLocation(exported);
  if (!location) throw new Error(`export operation ${exportOp}: the result carries no download location`);
  const archive = await t.download(location);
  if (archive.status !== 200 || !archive.data || archive.data.length === 0) {
    throw new Error(`export operation ${exportOp}: archive download returned ${archive.status}`);
  }
  const imported = await t.upload(bankPath(toBank, `/document-transfer?on_conflict=${onConflict}`), {
    fileName: typeof exported.filename === "string" && exported.filename ? exported.filename : "documents.zip",
    data: archive.data,
  });
  if (imported.status !== 200 && imported.status !== 202) throw new Error(`import: unexpected status ${imported.status}`);
  const importOp = imported.json?.operation_id;
  if (!importOp) throw new Error("import: the response carries no operation_id");
  const result = await waitOperation(t, toBank, importOp, opts);
  const documentsImported = count(result.documents_imported);
  const documentsSkipped = count(result.documents_skipped);
  if (documentsImported + documentsSkipped !== ids.length) {
    throw new Error(
      `transfer ${fromBank} -> ${toBank}: ${ids.length} document(s) requested, the import accounted for ` +
        `${documentsImported + documentsSkipped} (imported ${documentsImported}, skipped ${documentsSkipped})`,
    );
  }
  return { requested: ids.length, imported: documentsImported, skipped: documentsSkipped };
}

async function ensureBanks(t, state, bankIds, missions) {
  let created = 0;
  for (const bankId of bankIds) {
    if (state.banksCreated.includes(bankId)) continue;
    const mission = missions[bankId];
    const body = typeof mission === "string" && mission ? { reflect_mission: mission } : {};
    await requestOk(t, "PUT", bankPath(bankId), body, [200, 201, 204], `ensureBank(${bankId})`);
    state.banksCreated.push(bankId);
    created += 1;
  }
  return created;
}

function groupByBank(pairs) {
  const groups = new Map();
  for (const [bankId, documentId] of pairs) {
    if (!groups.has(bankId)) groups.set(bankId, []);
    groups.get(bankId).push(documentId);
  }
  return groups;
}

/**
 * Move every pending document of a bank group through transferDocuments, one
 * batch at a time; the copied set is updated (and checkpointed) per batch.
 */
async function moveGroups(t, state, groups, onConflict, opts) {
  const moved = [];
  let imported = 0;
  let skipped = 0;
  let batches = 0;
  for (const [bankId, ids] of groups) {
    for (const batch of makeBatches(ids, opts.batchSize ?? DEFAULT_BATCH_SIZE)) {
      const result = await transferDocuments(t, state.sourceBank, bankId, batch, onConflict, opts);
      imported += result.imported;
      skipped += result.skipped;
      batches += 1;
      for (const id of batch) {
        if (!state.copied.includes(id)) state.copied.push(id);
        moved.push(id);
      }
      invalidateAfterMove(state);
      opts.checkpoint?.();
    }
  }
  return { moved, imported, skipped, batches };
}

// ---------------------------------------------------------------------------
// Step engines: copy / delta / verify / purge / rollback
// ---------------------------------------------------------------------------

/**
 * copy: create the target banks and move the classified documents.
 * Idempotent: ids already in state.copied are skipped.
 */
export async function runCopy(t, state, missions, opts = {}) {
  const copied = new Set(state.copied);
  const pending = state.classifications.filter((c) => c.targetBank !== state.sourceBank && !copied.has(c.documentId));
  const groups = groupByBank(pending.map((c) => [c.targetBank, c.documentId]));
  if (opts.dryRun) {
    let batches = 0;
    for (const ids of groups.values()) batches += makeBatches(ids, opts.batchSize ?? DEFAULT_BATCH_SIZE).length;
    return {
      step: "copy (dry-run)",
      counts: { documentsTotal: pending.length, documentsMoved: 0, batches, banksCreated: 0 },
      documentIds: pending.map((c) => c.documentId),
    };
  }
  const banksCreated = await ensureBanks(t, state, groups.keys(), missions);
  opts.checkpoint?.();
  const result = await moveGroups(t, state, groups, "skip", opts);
  return {
    step: "copy",
    counts: {
      documentsTotal: pending.length,
      documentsMoved: result.moved.length,
      documentsImported: result.imported,
      documentsSkipped: result.skipped,
      batches: result.batches,
      banksCreated,
    },
    documentIds: result.moved,
  };
}

function updatedSince(docs, since) {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new Error("the timestamp given as --since (or recorded as t0) is not a valid ISO date");
  const invalid = docs.filter((d) => Number.isNaN(Date.parse(d.updatedAt)));
  if (invalid.length > 0) {
    throw new Error(`${invalid.length} document(s) in the listing have no valid updatedAt: ${invalid.map((d) => d.id).join(", ")}`);
  }
  return docs.filter((d) => Date.parse(d.updatedAt) >= sinceMs);
}

/**
 * delta: re-move the documents updated at/after `since` with on_conflict=replace.
 * `docs` is a fresh listing of the source bank. A document that has no
 * classification yet (it appeared after classify) is classified with `map`; when
 * there is no map the step fails with the counter instead of skipping it.
 */
export async function runDelta(t, state, docs, map, missions, opts = {}) {
  const since = opts.since ?? state.t0;
  const recent = updatedSince(docs, since);
  const known = new Map(state.classifications.map((c) => [c.documentId, c]));
  const unclassified = recent.filter((d) => !known.has(d.id));
  if (unclassified.length > 0 && !map) {
    throw new Error(
      `delta: ${unclassified.length} document(s) updated since ${since} have no classification; ` +
        "pass --agent-map so they can be classified",
    );
  }
  const added = unclassified.map((d) => classifyDocument(d, map, state.sourceBank));
  for (const c of added) known.set(c.documentId, c);
  const pending = recent.filter((d) => known.get(d.id).targetBank !== state.sourceBank);
  const groups = groupByBank(pending.map((d) => [known.get(d.id).targetBank, d.id]));
  if (opts.dryRun) {
    return {
      step: "delta (dry-run)",
      counts: { updatedSince: recent.length, newlyClassified: added.length, documentsMoved: 0, documentsPending: pending.length },
      documentIds: [],
    };
  }
  state.classifications.push(...added);
  const banksCreated = await ensureBanks(t, state, groups.keys(), missions);
  opts.checkpoint?.();
  const result = await moveGroups(t, state, groups, "replace", opts);
  state.lastDeltaAt = new Date().toISOString();
  return {
    step: "delta",
    counts: {
      updatedSince: recent.length,
      newlyClassified: added.length,
      documentsMoved: result.moved.length,
      documentsImported: result.imported,
      documentsSkipped: result.skipped,
      batches: result.batches,
      banksCreated,
    },
    documentIds: result.moved,
  };
}

/**
 * verify: each target bank's listing against the source listing, by the
 * classification. Compared: document counts, world/experience sums, and the
 * (id, textSha256) pair per document; documents that belong elsewhere are leaks.
 * `bankDocuments` is a direct map bank -> [{id, textSha256, units}]. Returns the
 * findings (an empty list is a pass); only ids and counters, never content.
 */
export function runVerify(state, sourceDocs, bankDocuments) {
  const findings = [];
  const counts = {};
  const source = new Map(sourceDocs.map((d) => [d.id, d]));
  const classified = new Map(state.classifications.map((c) => [c.documentId, c]));
  const expectedByBank = new Map();
  for (const c of state.classifications) {
    if (c.targetBank === state.sourceBank) continue;
    if (!expectedByBank.has(c.targetBank)) expectedByBank.set(c.targetBank, []);
    expectedByBank.get(c.targetBank).push(c.documentId);
  }
  const bankIds = new Set([...expectedByBank.keys(), ...Object.keys(bankDocuments).filter((b) => b !== state.sourceBank)]);
  for (const bankId of [...bankIds].sort()) {
    const actual = bankDocuments[bankId];
    if (!actual) findings.push(`verify: no listing supplied for ${bankId}`);
    const actualDocs = actual ?? [];
    const actualById = new Map(actualDocs.map((d) => [d.id, d]));
    const expectedIds = expectedByBank.get(bankId) ?? [];
    const expectedWorld = { world: 0, experience: 0 };
    for (const id of expectedIds) {
      const src = source.get(id);
      if (!src) {
        findings.push(`verify: ${id} is classified to ${bankId} but is absent from the source listing`);
        continue;
      }
      expectedWorld.world += src.units.world;
      expectedWorld.experience += src.units.experience;
      const got = actualById.get(id);
      if (!got) findings.push(`verify: ${id} is missing from ${bankId}`);
      else if (got.textSha256 !== src.textSha256) findings.push(`verify: ${id} in ${bankId} differs from the source (textSha256)`);
    }
    let world = 0;
    let experience = 0;
    for (const d of actualDocs) {
      world += d.units.world;
      experience += d.units.experience;
      const c = classified.get(d.id);
      if (!c) findings.push(`verify: ${d.id} in ${bankId} is not in the classification (leak)`);
      else if (c.targetBank !== bankId) findings.push(`verify: ${d.id} in ${bankId} belongs to ${c.targetBank} (leak)`);
    }
    if (actualById.size !== actualDocs.length) findings.push(`verify: ${bankId} lists a document id more than once`);
    if (actualDocs.length !== expectedIds.length) {
      findings.push(`verify: ${bankId} has ${actualDocs.length} document(s), expected ${expectedIds.length}`);
    }
    if (world !== expectedWorld.world) findings.push(`verify: ${bankId} has ${world} world unit(s), expected ${expectedWorld.world}`);
    if (experience !== expectedWorld.experience) {
      findings.push(`verify: ${bankId} has ${experience} experience unit(s), expected ${expectedWorld.experience}`);
    }
    counts[`${bankId}.documents`] = actualDocs.length;
    counts[`${bankId}.world`] = world;
    counts[`${bankId}.experience`] = experience;
    counts[`${bankId}.expectedDocuments`] = expectedIds.length;
  }
  return { ok: findings.length === 0, counts, findings };
}

async function listUnits(t, bankId, type) {
  const items = [];
  let offset = 0;
  for (;;) {
    const res = await requestOk(
      t,
      "GET",
      bankPath(bankId, `/memories/list?type=${type}&limit=${PAGE_SIZE}&offset=${offset}`),
      undefined,
      [200],
      `list ${type} units`,
    );
    const page = res.json?.items ?? [];
    for (const item of page) {
      items.push({ id: item.id, documentId: item.document_id ?? null, sources: item.source_memory_ids ?? [] });
    }
    offset += page.length;
    if (page.length === 0 || offset >= count(res.json?.total)) return items;
  }
}

/**
 * Which memory units to clear so that no observation built from a purged
 * document survives (deleting a document does not delete its observations).
 * A DELETE on a memory removes the observations derived from it and resets that
 * memory for re-consolidation, so:
 *   - a mixed observation (has an own source) is cleared through ALL its own
 *     sources: they are reset and rebuilt from own facts only;
 *   - a purely foreign observation is cleared through one foreign source.
 */
async function planObservationClearing(t, sourceBank, purgeSet) {
  const documentOf = new Map();
  for (const type of ["world", "experience"]) {
    for (const unit of await listUnits(t, sourceBank, type)) documentOf.set(unit.id, unit.documentId);
  }
  const observations = await listUnits(t, sourceBank, "observation");
  const isForeign = (memoryId) => {
    const documentId = documentOf.get(memoryId);
    return documentId !== undefined && documentId !== null && purgeSet.has(documentId);
  };
  const toClear = new Set();
  const counters = { observationsMixed: 0, observationsPureForeign: 0, observationsNoSources: 0, unknownSources: 0 };
  for (const observation of observations) {
    if (observation.sources.length === 0) {
      counters.observationsNoSources += 1;
      continue;
    }
    // An observation with no foreign source is the source bank's own: untouched.
    if (!observation.sources.some(isForeign)) continue;
    for (const id of observation.sources) if (!documentOf.has(id)) counters.unknownSources += 1;
    // A source not known as a foreign fact counts as own: clearing an own
    // source only triggers re-consolidation, it can never lose a fact.
    const own = observation.sources.filter((id) => !isForeign(id));
    if (own.length > 0) {
      counters.observationsMixed += 1;
      for (const id of own) toClear.add(id);
    } else {
      counters.observationsPureForeign += 1;
      // One foreign source is enough; an earlier clear may already have removed it.
      if (!observation.sources.some((id) => toClear.has(id))) toClear.add(observation.sources[0]);
    }
  }
  return { memoryIds: [...toClear], counters };
}

async function setAutoConsolidation(t, bankId, enabled) {
  await requestOk(t, "PATCH", bankPath(bankId, "/config"), { updates: { enable_auto_consolidation: enabled } }, [200], "set auto-consolidation");
}

/**
 * purge: clean the source bank of the moved documents. Order: disable
 * auto-consolidation, clear observations, delete documents, restore
 * auto-consolidation. Never touches documents classified to the source bank.
 * Requires a passing verify. A failure midway leaves auto-consolidation off and
 * says so; a repeat resumes (the pre-purge setting is recorded in the state).
 */
export async function runPurge(t, state, opts = {}) {
  const kept = new Set(state.classifications.filter((c) => c.targetBank === state.sourceBank).map((c) => c.documentId));
  const purged = new Set(state.purged);
  const deletable = state.copied.filter((id) => !kept.has(id) && !purged.has(id));
  const counts = {
    documentsDeletable: deletable.length,
    documentsDeleted: 0,
    documentsAlreadyGone: 0,
    ownDocumentsUntouched: kept.size,
    memoriesToClear: 0,
    observationsDeleted: 0,
  };
  const emptyResult = (step) => ({ step, counts, documentIds: [] });

  if (opts.dryRun) {
    // Read-only planning: GET requests only, nothing is written.
    if (deletable.length > 0 && !state.purge?.observationsCleared) {
      const plan = await planObservationClearing(t, state.sourceBank, new Set(deletable));
      counts.memoriesToClear = plan.memoryIds.length;
      Object.assign(counts, plan.counters);
    }
    return { step: "purge (dry-run)", counts, documentIds: deletable };
  }
  if (deletable.length === 0) return emptyResult("purge");
  if (!state.verifiedAt) {
    throw new Error("purge: no passing verify since the last move; run verify first (purge deletes irreversibly)");
  }

  if (!state.purge) {
    const config = await requestOk(t, "GET", bankPath(state.sourceBank, "/config"), undefined, [200], "read config");
    const before = config.json?.config?.enable_auto_consolidation;
    if (typeof before !== "boolean") throw new Error("purge: cannot read enable_auto_consolidation of the source bank");
    state.purge = { consolidationBefore: before, observationsCleared: false, consolidationRestored: false };
    opts.checkpoint?.();
  }
  try {
    await setAutoConsolidation(t, state.sourceBank, false);
    state.purge.consolidationRestored = false;
    opts.checkpoint?.();

    if (!state.purge.observationsCleared) {
      const plan = await planObservationClearing(t, state.sourceBank, new Set(deletable));
      counts.memoriesToClear = plan.memoryIds.length;
      Object.assign(counts, plan.counters);
      for (const memoryId of plan.memoryIds) {
        const res = await requestOk(
          t,
          "DELETE",
          bankPath(state.sourceBank, `/memories/${encodeURIComponent(memoryId)}/observations`),
          undefined,
          [200],
          `clear observations of ${memoryId}`,
        );
        counts.observationsDeleted += count(res.json?.deleted_count);
      }
      state.purge.observationsCleared = true;
      opts.checkpoint?.();
    }

    const deletedIds = [];
    for (const id of deletable) {
      const res = await t.request("DELETE", bankPath(state.sourceBank, `/documents/${encodeURIComponent(id)}`));
      if (res.status === 404) counts.documentsAlreadyGone += 1;
      else if (![200, 202, 204].includes(res.status)) throw new Error(`purge: delete of ${id} failed with status ${res.status}`);
      state.purged.push(id);
      deletedIds.push(id);
      counts.documentsDeleted += 1;
      if (counts.documentsDeleted % CHECKPOINT_EVERY === 0) opts.checkpoint?.();
    }

    await setAutoConsolidation(t, state.sourceBank, state.purge.consolidationBefore);
    state.purge.consolidationRestored = true;
    opts.checkpoint?.();
    return { step: "purge", counts, documentIds: deletedIds };
  } catch (error) {
    const note = state.purge.consolidationRestored
      ? ""
      : `; auto-consolidation of ${state.sourceBank} may still be disabled (was ${state.purge.consolidationBefore}), a repeat of purge resumes and restores it`;
    throw new Error(`${error?.message ?? error}${note}`);
  }
}

/**
 * rollback: bring the documents written into the target banks since the switch
 * moment back into the source bank (on_conflict=replace: the target's copy is
 * the newer one). It never deletes from the target banks (they stay until the
 * operator has analysed them) and it refuses after purge, when the way back is
 * the archive. `bankDocuments` is a direct map bank -> [{id, updatedAt}].
 */
export async function runRollback(t, state, bankDocuments, opts = {}) {
  if (state.purged.length > 0 || state.purge) {
    throw new Error("rollback: the source bank was already purged; restore it from the archive instead");
  }
  if (!opts.since) throw new Error("rollback: the switch moment is required (--since)");
  const pairs = [];
  for (const [bankId, docs] of Object.entries(bankDocuments)) {
    if (bankId === state.sourceBank) continue;
    for (const d of updatedSince(docs, opts.since)) pairs.push([bankId, d.id]);
  }
  const groups = groupByBank(pairs);
  let imported = 0;
  let skipped = 0;
  let batches = 0;
  const movedIds = [];
  if (!opts.dryRun) {
    for (const [bankId, ids] of groups) {
      for (const batch of makeBatches(ids, opts.batchSize ?? DEFAULT_BATCH_SIZE)) {
        const result = await transferDocuments(t, bankId, state.sourceBank, batch, "replace", opts);
        imported += result.imported;
        skipped += result.skipped;
        batches += 1;
        movedIds.push(...batch);
      }
    }
  }
  return {
    step: opts.dryRun ? "rollback (dry-run)" : "rollback",
    counts: { documentsSince: pairs.length, documentsMovedBack: movedIds.length, documentsImported: imported, documentsSkipped: skipped, batches },
    documentIds: opts.dryRun ? pairs.map(([, id]) => id) : movedIds,
  };
}

// ---------------------------------------------------------------------------
// fetch transport (CLI only; tests inject a mock)
// ---------------------------------------------------------------------------

export function createFetchTransport(baseUrl, apiToken) {
  const auth = () => (apiToken ? { authorization: `Bearer ${apiToken}` } : {});
  const parse = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };
  return {
    async request(method, urlPath, body) {
      const headers = { ...auth() };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(joinUrl(baseUrl, urlPath), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await parse(res) };
    },
    async upload(urlPath, file) {
      const form = new FormData();
      form.append("file", new Blob([file.data]), file.fileName);
      const res = await fetch(joinUrl(baseUrl, urlPath), { method: "POST", headers: auth(), body: form });
      return { status: res.status, json: await parse(res) };
    },
    async download(location) {
      const url = location.startsWith("/") ? joinUrl(baseUrl, location) : location;
      // A presigned object-store URL is absolute and carries its own signature:
      // the API token goes only to the API's own origin.
      const sameOrigin = new URL(url).origin === new URL(baseUrl).origin;
      const res = await fetch(url, { headers: sameOrigin ? auth() : {} });
      return { status: res.status, data: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const STEPS = new Set(["classify", "copy", "delta", "verify", "purge", "rollback"]);
const VALUE_FLAGS = new Set(["api-url", "source-bank", "state", "documents", "agent-map", "missions", "bank-documents", "since"]);

function usage(log) {
  log.error(
    [
      "usage: node split-banks.mjs <step> --api-url URL --source-bank ID --state FILE [--dry-run]",
      "  step: classify | copy | delta | verify | purge | rollback",
      "  classify:  --documents FILE (JSON list of the source bank's documents) --agent-map FILE",
      "             (JSON: byAgentIdentity/byAgentId/byOperatorTag/byDomainTag)",
      "  copy:      [--missions FILE]  (JSON: bank -> reflect mission)",
      "  delta:     --documents FILE (fresh listing) [--since ISO] [--agent-map FILE] [--missions FILE]",
      "  verify:    --documents FILE (source listing) --bank-documents FILE (JSON: bank -> [{id, textSha256, units}])",
      "  purge:     (state only; needs a passing verify)",
      "  rollback:  --bank-documents FILE (JSON: bank -> [{id, updatedAt}]) --since ISO",
      "exit codes: 0 ok, 1 step failed, 2 usage error",
    ].join("\n"),
  );
  return 2;
}

export function parseArgs(argv) {
  const args = { dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag ${a}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${a}`);
      args[key] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1 || !STEPS.has(positional[0])) throw new Error("step must be one of classify/copy/delta/verify/purge/rollback");
  args.step = positional[0];
  return args;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireFlag(args, name) {
  if (typeof args[name] !== "string" || !args[name]) throw new UsageError(`--${name} is required for ${args.step}`);
  return args[name];
}

class UsageError extends Error {}

/**
 * CLI entry. Returns the exit code. `deps.transport` replaces the fetch
 * transport (tests); `deps.pollIntervalMs` / `deps.sleep` speed up polling.
 */
export async function main(argv = process.argv.slice(2), log = console, deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log.error(String(error?.message ?? error));
    return usage(log);
  }
  const { "api-url": apiUrl, "source-bank": sourceBank, state: stateFile } = args;
  if (!apiUrl || !sourceBank || !stateFile) return usage(log);
  const transport = deps.transport ?? createFetchTransport(apiUrl, process.env.HINDSIGHT_API_KEY);
  try {
    return await runStep(transport, args, log, deps);
  } catch (error) {
    log.error(String(error?.message ?? error));
    return error instanceof UsageError ? usage(log) : 1;
  }
}

async function runStep(transport, args, log, deps) {
  const { "source-bank": sourceBank, state: stateFile, dryRun } = args;
  const state = fs.existsSync(stateFile) ? loadSplitState(stateFile) : newSplitState(sourceBank, new Date().toISOString());
  if (state.sourceBank !== sourceBank) throw new Error("the state file belongs to a different source bank");
  const save = () => {
    if (!dryRun) saveSplitState(stateFile, state);
  };
  const opts = { dryRun, checkpoint: save, sleep: deps.sleep, pollIntervalMs: deps.pollIntervalMs };
  const missions = () => (args.missions ? readJsonFile(args.missions) : {});
  let report;

  switch (args.step) {
    case "classify": {
      const documents = readJsonFile(requireFlag(args, "documents"));
      const map = readJsonFile(requireFlag(args, "agent-map"));
      const classifications = classifyDocuments(documents, map, sourceBank);
      state.classifications = classifications;
      save();
      const byBank = {};
      const byRule = {};
      for (const c of classifications) {
        byBank[c.targetBank] = (byBank[c.targetBank] ?? 0) + 1;
        byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
      }
      log.log(JSON.stringify({ step: dryRun ? "classify (dry-run)" : "classify", byBank, byRule }));
      return 0;
    }
    case "copy":
      try {
        report = await runCopy(transport, state, missions(), opts);
      } finally {
        save();
      }
      break;
    case "delta": {
      const documents = readJsonFile(requireFlag(args, "documents"));
      const map = args["agent-map"] ? readJsonFile(args["agent-map"]) : null;
      try {
        report = await runDelta(transport, state, documents, map, missions(), { ...opts, since: args.since });
      } finally {
        save();
      }
      break;
    }
    case "verify": {
      const documents = readJsonFile(requireFlag(args, "documents"));
      const bankDocuments = readJsonFile(requireFlag(args, "bank-documents"));
      report = runVerify(state, documents, bankDocuments);
      state.verifiedAt = report.ok ? new Date().toISOString() : null;
      save();
      break;
    }
    case "purge":
      try {
        report = await runPurge(transport, state, opts);
      } finally {
        save();
      }
      break;
    case "rollback": {
      const bankDocuments = readJsonFile(requireFlag(args, "bank-documents"));
      report = await runRollback(transport, state, bankDocuments, { ...opts, since: requireFlag(args, "since") });
      break;
    }
    default:
      throw new UsageError(`unknown step ${args.step}`);
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
  main().then((code) => {
    process.exitCode = code;
  });
}
