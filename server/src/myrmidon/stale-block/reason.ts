// myrmidon(STALE-BLOCK): the fixed reason contract of part A (OPE-3795-A).
// Part A owns the shared type, the validator and the routes; until its merge
// this module reads the shape defensively (structural read, never a write) so
// part B works on plain JSON. Do not edit part A's files from part B.

/** The reason reference inside `unblockDescriptor` (part A contract, fixed). */
export interface StaleBlockReasonRef {
  kind: "issue" | "event" | "date";
  issueId?: string;
  eventKey?: string;
  dueAt?: string;
}

const REASON_REF_KINDS: ReadonlySet<string> = new Set(["issue", "event", "date"]);

/**
 * Reads `reasonRef` from an `unblockDescriptor` JSON value without assuming
 * part A's validator: only a structurally valid object counts, anything else
 * reads as `null` (unknown reason → the block is left alone).
 */
export function readReasonRef(descriptor: unknown): StaleBlockReasonRef | null {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  const value = (descriptor as Record<string, unknown>).reasonRef;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (typeof ref.kind !== "string" || !REASON_REF_KINDS.has(ref.kind)) return null;
  const out: StaleBlockReasonRef = { kind: ref.kind as StaleBlockReasonRef["kind"] };
  if (typeof ref.issueId === "string" && ref.issueId !== "") out.issueId = ref.issueId;
  if (typeof ref.eventKey === "string" && ref.eventKey !== "") out.eventKey = ref.eventKey;
  if (typeof ref.dueAt === "string" && ref.dueAt !== "") out.dueAt = ref.dueAt;
  return out;
}

/** Terminal blocker statuses: the blocker no longer holds the dependency. */
export const DEAD_BLOCKER_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);
