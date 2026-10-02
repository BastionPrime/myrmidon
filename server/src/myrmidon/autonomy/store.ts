// myrmidon(1.6-AUTONOMY): autonomy state storage.
//
// The matrix and the per-role regulations live under our own key of
// instance_settings.general (the same rule as maintenance mode, the browser
// console and the cloud connector): the vendor settings service strips unknown
// keys, so this module reads and writes the raw row itself. No migration, and
// an old image keeps working on the new schema.
//
// The change log is derived from `activity_log` rows the service writes on
// every mutation, so this document only holds current state.

import { eq, sql } from "drizzle-orm";
import { agents, instanceSettings, type Db } from "@paperclipai/db";
import {
  AUTONOMY_ACTION_CLASSES,
  AUTONOMY_CHANGE_ACTIONS,
  AUTONOMY_VERDICTS,
  defaultAutonomyMatrix,
  type AutonomyActionClass,
  type AutonomyActorRef,
  type AutonomyChangeAction,
  type AutonomyChangeLogEntry,
  type AutonomyMatrix,
  type AutonomyRegulation,
  type AutonomyRegulationRevision,
  type AutonomyRegulationStatus,
  type AutonomyRule,
  type AutonomyVerdict,
} from "@paperclipai/shared";

export const AUTONOMY_GENERAL_KEY = "myrmidonAutonomyMatrix";

const SINGLETON_KEY = "default";
/** How many regulation revisions per regulation are kept in the document. */
export const AUTONOMY_REVISION_LIMIT = 50;

/** The persisted shape. `version` is the document revision, not the matrix version. */
export interface AutonomyDocument {
  version: 1;
  matrix: AutonomyMatrix;
  regulations: AutonomyRegulation[];
}

export function emptyAutonomyDocument(): AutonomyDocument {
  return { version: 1, matrix: defaultAutonomyMatrix(), regulations: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isActionClass(value: unknown): value is AutonomyActionClass {
  return typeof value === "string" && (AUTONOMY_ACTION_CLASSES as readonly string[]).includes(value);
}

function isVerdict(value: unknown): value is AutonomyVerdict {
  return typeof value === "string" && (AUTONOMY_VERDICTS as readonly string[]).includes(value);
}

function isChangeAction(value: unknown): value is AutonomyChangeAction {
  return typeof value === "string" && (AUTONOMY_CHANGE_ACTIONS as readonly string[]).includes(value);
}

function isRegulationStatus(value: unknown): value is AutonomyRegulationStatus {
  return value === "draft" || value === "approved";
}

function parseActor(value: unknown): AutonomyActorRef {
  if (isRecord(value)) {
    const type = str(value.type);
    const id = str(value.id);
    if ((type === "board" || type === "agent" || type === "system") && id) return { type, id };
  }
  return { type: "system", id: "system" };
}

function parseRule(value: unknown): AutonomyRule | null {
  if (!isRecord(value)) return null;
  const role = str(value.role);
  if (!role || !isActionClass(value.actionClass) || !isVerdict(value.verdict)) return null;
  const agentId = str(value.agentId);
  return { role, actionClass: value.actionClass, verdict: value.verdict, agentId };
}

function parseRevision(value: unknown): AutonomyRegulationRevision | null {
  if (!isRecord(value)) return null;
  const revision = typeof value.revision === "number" ? value.revision : null;
  const title = str(value.title);
  const at = str(value.at);
  if (revision === null || revision <= 0 || !title || !at) return null;
  return {
    revision,
    title,
    bodyMarkdown: typeof value.bodyMarkdown === "string" ? value.bodyMarkdown : "",
    status: isRegulationStatus(value.status) ? value.status : "draft",
    author: parseActor(value.author),
    at,
  };
}

function parseRegulation(value: unknown): AutonomyRegulation | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const role = str(value.role);
  const title = str(value.title);
  const revision = typeof value.revision === "number" ? value.revision : null;
  const createdAt = str(value.createdAt);
  const updatedAt = str(value.updatedAt);
  if (!id || !role || !title || revision === null || revision <= 0 || !createdAt || !updatedAt) return null;
  const revisions = Array.isArray(value.revisions)
    ? value.revisions.map(parseRevision).filter((entry): entry is AutonomyRegulationRevision => entry !== null)
    : [];
  return {
    id,
    role,
    title,
    bodyMarkdown: typeof value.bodyMarkdown === "string" ? value.bodyMarkdown : "",
    status: isRegulationStatus(value.status) ? value.status : "draft",
    revision,
    revisions,
    createdAt,
    createdBy: parseActor(value.createdBy),
    updatedAt,
    updatedBy: parseActor(value.updatedBy),
    supersededBy: str(value.supersededBy),
    wikiPageId: str(value.wikiPageId),
  };
}

/** Parse a stored value into a document, filling every absent field with the safe default. */
export function parseAutonomyDocument(raw: unknown): AutonomyDocument {
  if (!isRecord(raw)) return emptyAutonomyDocument();
  const rawMatrix = isRecord(raw.matrix) ? raw.matrix : {};
  const defaults = { ...defaultAutonomyMatrix().defaults };
  if (isRecord(rawMatrix.defaults)) {
    for (const actionClass of AUTONOMY_ACTION_CLASSES) {
      const value = rawMatrix.defaults[actionClass];
      if (isVerdict(value)) defaults[actionClass] = value;
    }
  }
  const rules = Array.isArray(rawMatrix.rules)
    ? rawMatrix.rules.map(parseRule).filter((rule): rule is AutonomyRule => rule !== null)
    : [];
  const version = typeof rawMatrix.version === "number" && rawMatrix.version >= 0 ? Math.floor(rawMatrix.version) : 1;
  const regulations = Array.isArray(raw.regulations)
    ? raw.regulations.map(parseRegulation).filter((entry): entry is AutonomyRegulation => entry !== null)
    : [];
  return { version: 1, matrix: { version, rules, defaults }, regulations };
}

/** Keep our key across vendor writes of instance_settings.general. */
export function preserveAutonomyGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[AUTONOMY_GENERAL_KEY];
  return value === undefined ? {} : { [AUTONOMY_GENERAL_KEY]: value };
}

/** The persistence seam: production uses the instance-settings row, tests use memory. */
export interface AutonomyStore {
  read(): Promise<AutonomyDocument>;
  mutate<T>(change: (current: AutonomyDocument) => { next: AutonomyDocument | null; result: T }): Promise<{
    doc: AutonomyDocument;
    result: T;
    changed: boolean;
  }>;
}

type Runner = Pick<Db, "select" | "insert" | "update">;

export async function readAutonomyDocument(db: Runner): Promise<AutonomyDocument> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseAutonomyDocument(row?.general?.[AUTONOMY_GENERAL_KEY]);
}

/**
 * Read-modify-write under a row lock: the change callback sees the current
 * document and returns the next one (or null to keep the stored value). The
 * lock is what makes the matrix version check meaningful under concurrency.
 */
export async function mutateAutonomyDocument<T>(
  db: Db,
  change: (current: AutonomyDocument) => { next: AutonomyDocument | null; result: T },
): Promise<{ doc: AutonomyDocument; result: T; changed: boolean }> {
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
    const current = parseAutonomyDocument(row.general?.[AUTONOMY_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${AUTONOMY_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

export function dbAutonomyStore(db: Db): AutonomyStore {
  return {
    read: () => readAutonomyDocument(db),
    mutate: (change) => mutateAutonomyDocument(db, change),
  };
}

/** In-memory store: used by tests and by any read-only embedding of the module. */
export function memoryAutonomyStore(initial?: AutonomyDocument): AutonomyStore {
  let document = initial ?? emptyAutonomyDocument();
  return {
    read: async () => document,
    mutate: async (change) => {
      const { next, result } = change(document);
      if (next) document = next;
      return { doc: document, result, changed: next !== null };
    },
  };
}

/**
 * The caste key of an agent: `agents.role`, the same label a `caste` grant
 * matches on. One primary-key read; an unknown agent reads as "no role", which
 * can never match a role rule by accident.
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

export { isChangeAction, isRegulationStatus, isActionClass, isVerdict };