// myrmidon(CLOUD-CONNECTOR): connector state storage.
//
// State lives under our own key of instance_settings.general (the same rule
// as maintenance mode and the browser console): the vendor settings service
// strips unknown keys, so this module reads and writes the raw row itself.
// No migrations, and an old image keeps working on the new schema.

import { eq, sql } from "drizzle-orm";
import { agents, instanceSettings, type Db } from "@paperclipai/db";
import type {
  CloudAccount,
  CloudGrant,
  CloudGrantTargetKind,
  CloudJournalEntry,
  CloudProviderId,
  CloudRoot,
} from "@paperclipai/shared/myrmidon-cloud-connector";

export const CLOUD_CONNECTOR_GENERAL_KEY = "myrmidonCloudConnector";

const SINGLETON_KEY = "default";
const JOURNAL_LIMIT = 200;

export interface CloudConnectorDocument {
  version: 1;
  accounts: CloudAccount[];
  roots: CloudRoot[];
  grants: CloudGrant[];
  journal: CloudJournalEntry[];
}

export function emptyCloudConnectorDocument(): CloudConnectorDocument {
  return { version: 1, accounts: [], roots: [], grants: [], journal: [] };
}

export function appendJournal(document: CloudConnectorDocument, entry: CloudJournalEntry): CloudConnectorDocument {
  const journal = [entry, ...document.journal].slice(0, JOURNAL_LIMIT);
  return { ...document, journal };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAccount(value: unknown): CloudAccount | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const providerId = str(value.providerId);
  const displayName = str(value.displayName);
  const tokenRef = str(value.tokenRef);
  const connectedAt = str(value.connectedAt);
  const connectedBy = str(value.connectedBy);
  if (!id || !providerId || !displayName || !tokenRef || !connectedAt || !connectedBy) return null;
  const scopes = Array.isArray(value.scopes) ? value.scopes.filter((s): s is string => typeof s === "string") : [];
  return {
    id,
    providerId: providerId as CloudProviderId,
    displayName,
    companyId: str(value.companyId),
    tokenRef,
    scopes,
    connectedAt,
    connectedBy,
  };
}

function parseRoot(value: unknown): CloudRoot | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const providerId = str(value.providerId);
  const name = str(value.name);
  const kind = str(value.kind);
  const createdAt = str(value.createdAt);
  if (!id || !providerId || !name || (kind !== "own" && kind !== "shared") || !createdAt) return null;
  return {
    id,
    providerId: providerId as CloudProviderId,
    companyId: str(value.companyId),
    name,
    kind,
    description: typeof value.description === "string" ? value.description : "",
    driveId: str(value.driveId),
    itemId: str(value.itemId),
    folder: str(value.folder),
    personalForAgentId: str(value.personalForAgentId),
    createdAt,
  };
}

function parseGrant(value: unknown): CloudGrant | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const rootId = str(value.rootId);
  const targetKind = str(value.targetKind);
  const mode = str(value.mode);
  const createdAt = str(value.createdAt);
  const createdBy = str(value.createdBy);
  if (!id || !rootId || !createdAt || !createdBy) return null;
  if (targetKind !== "agent" && targetKind !== "caste" && targetKind !== "all") return null;
  if (mode !== "ro" && mode !== "rw") return null;
  return {
    id,
    rootId,
    targetKind: targetKind as CloudGrantTargetKind,
    agentId: str(value.agentId),
    caste: str(value.caste),
    mode,
    createdAt,
    createdBy,
  };
}

function parseJournalEntry(value: unknown): CloudJournalEntry | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const at = str(value.at);
  const actor = str(value.actor);
  const tool = str(value.tool);
  if (!id || !at || !actor || !tool) return null;
  return {
    id,
    at,
    actor,
    tool,
    rootId: str(value.rootId),
    rootName: str(value.rootName),
    path: str(value.path),
    ok: value.ok === true,
    detail: str(value.detail),
  };
}

/** Read defensively: anything malformed reads as an empty document. */
export function parseCloudConnectorDocument(raw: unknown): CloudConnectorDocument {
  if (!isRecord(raw)) return emptyCloudConnectorDocument();
  const list = <T>(value: unknown, parse: (entry: unknown) => T | null): T[] =>
    Array.isArray(value) ? value.map(parse).filter((entry): entry is T => entry !== null) : [];
  return {
    version: 1,
    accounts: list(raw.accounts, parseAccount),
    roots: list(raw.roots, parseRoot),
    grants: list(raw.grants, parseGrant),
    journal: list(raw.journal, parseJournalEntry),
  };
}

/** The persistence seam: production uses the instance-settings row, tests use memory. */
export interface CloudConnectorStore {
  read(): Promise<CloudConnectorDocument>;
  mutate<T>(
    change: (current: CloudConnectorDocument) => { next: CloudConnectorDocument | null; result: T },
  ): Promise<{ doc: CloudConnectorDocument; result: T; changed: boolean }>;
}

export function dbCloudConnectorStore(db: Db): CloudConnectorStore {
  return {
    read: () => readCloudConnectorDocument(db),
    mutate: (change) => mutateCloudConnectorDocument(db, change),
  };
}

/**
 * The board role of an agent: the label a `caste` grant matches on. One
 * primary-key read per tool call; an unknown agent reads as "no caste", so a
 * caste grant can never match by accident.
 */
export function agentRoleFromDb(db: Db): (agentId: string) => Promise<string | null> {
  return async (agentId) => {
    const [row] = await db
      .select({ role: agents.role })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row?.role ?? null;
  };
}

/** In-memory store: used by tests and by any read-only embedding of the module. */
export function memoryCloudConnectorStore(initial?: CloudConnectorDocument): CloudConnectorStore {
  let document = initial ?? emptyCloudConnectorDocument();
  return {
    read: async () => document,
    mutate: async (change) => {
      const { next, result } = change(document);
      if (next) document = next;
      return { doc: document, result, changed: next !== null };
    },
  };
}

/** Keep our key across vendor writes of `instance_settings.general` (see instance-settings.ts). */
export function preserveCloudConnectorGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[CLOUD_CONNECTOR_GENERAL_KEY];
  return value === undefined ? {} : { [CLOUD_CONNECTOR_GENERAL_KEY]: value };
}

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readCloudConnectorDocument(db: Runner): Promise<CloudConnectorDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseCloudConnectorDocument(row?.general?.[CLOUD_CONNECTOR_GENERAL_KEY]);
}

/**
 * Read-modify-write under a row lock, like the browser console store: the
 * change callback sees the current document and returns the next one (or null
 * to keep the stored value).
 */
export async function mutateCloudConnectorDocument<T>(
  db: Db,
  change: (current: CloudConnectorDocument) => { next: CloudConnectorDocument | null; result: T },
): Promise<{ doc: CloudConnectorDocument; result: T; changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = parseCloudConnectorDocument(row.general?.[CLOUD_CONNECTOR_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${CLOUD_CONNECTOR_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}