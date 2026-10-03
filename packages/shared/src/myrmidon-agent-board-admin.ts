/**
 * myrmidon(ADMIN-AGENT): the board administrator flag on an agent.
 *
 * A board administrator is an agent the organization trusts with
 * board-administration authority (the `users:manage_permissions` surface):
 * company members, roles, and permission grants. The flag lives in two places
 * on the agent detail payload:
 *
 * - `permissions.boardAdmin` — the stored permission value (optional until the
 *   server part of the feature lands; absent means "not an administrator").
 * - `access.boardAdmin` — the effective access-summary value the server
 *   resolves from the stored permission plus any explicit grant. The UI
 *   prefers this field when it is present.
 *
 * Both readers are fail-closed: any non-`true` value (absent, malformed,
 * legacy) reads as "not a board administrator", so an old server or a stale
 * cache can never make the UI display or toggle admin authority that is not
 * there.
 */

/** The key of the permission inside the agent's `permissions` object. */
export const AGENT_BOARD_ADMIN_PERMISSION_KEY = "boardAdmin";

/** The key of the effective flag inside the agent detail's `access` object. */
export const AGENT_BOARD_ADMIN_ACCESS_KEY = "boardAdmin";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The stored board administrator value, fail-closed to `false`. */
export function readAgentBoardAdminPermission(permissions: unknown): boolean {
  const record = asRecord(permissions);
  return record?.[AGENT_BOARD_ADMIN_PERMISSION_KEY] === true;
}

/** The effective access-summary board administrator value, fail-closed to `false`. */
export function readAgentBoardAdminAccess(access: unknown): boolean {
  const record = asRecord(access);
  return record?.[AGENT_BOARD_ADMIN_ACCESS_KEY] === true;
}

/**
 * The value the agent card should display: the access-summary value when the
 * server reports one, otherwise the stored permission value. Fail-closed.
 */
export function readAgentBoardAdmin(input: {
  permissions?: unknown;
  access?: unknown;
}): boolean {
  const accessRecord = asRecord(input.access);
  if (accessRecord && AGENT_BOARD_ADMIN_ACCESS_KEY in accessRecord) {
    return readAgentBoardAdminAccess(accessRecord);
  }
  return readAgentBoardAdminPermission(input.permissions);
}

// --- myrmidon(ADMIN-AGENT) server-side helpers ------------------------------
//
// The server part extends this UI contract with the grant bookkeeping the
// toggle needs. `BOARD_ADMIN_PERMISSION_KEYS` (re-exported from constants) is
// the full operator set the switch grants. The `boardAdminSavedGrantKeys`
// snapshot inside the agent `permissions` record remembers which set keys the
// agent already held before the first enable, so disable revokes only the keys
// the switch added and leaves personal grants (for example a separately issued
// `tasks:assign`) untouched. See PATCH /agents/:id/permissions in the server.

import { BOARD_ADMIN_PERMISSION_KEYS, type PermissionKey } from "./constants.js";

export { BOARD_ADMIN_PERMISSION_KEYS };

/** The snapshot key: grant keys the agent held before the first enable. */
export const AGENT_BOARD_ADMIN_SAVED_GRANT_KEYS = "boardAdminSavedGrantKeys";

const grantKeySet = new Set<string>(BOARD_ADMIN_PERMISSION_KEYS);

/** True when the key belongs to the board-admin operator set. */
export function isBoardAdminGrantKey(key: string): key is PermissionKey {
  return grantKeySet.has(key);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The keys the switch must revoke on disable: the set keys the agent currently
 * holds minus the keys recorded in the pre-enable snapshot. Personal grants
 * outside the operator set are never touched.
 */
export function boardAdminRevocableGrantKeys(
  heldGrantKeys: readonly string[],
  savedSnapshotKeys: readonly string[],
): PermissionKey[] {
  const saved = new Set(savedSnapshotKeys);
  return heldGrantKeys
    .filter((key) => grantKeySet.has(key) && !saved.has(key)) as PermissionKey[];
}

/** The set keys the agent is missing, in the order of the operator set. */
export function missingBoardAdminGrantKeys(
  heldGrantKeys: readonly string[],
): PermissionKey[] {
  const held = new Set(heldGrantKeys);
  return BOARD_ADMIN_PERMISSION_KEYS.filter((key) => !held.has(key));
}

/**
 * Read-time migration: an agent that already holds the full operator set reads
 * as a board administrator even if the stored flag was never set. Chosen over
 * a backfill write so existing grant state is never rewritten on read; the
 * first toggle of the switch persists the explicit flag and snapshot.
 */
export function deriveBoardAdminFromGrants(
  heldGrantKeys: readonly string[],
): boolean {
  return BOARD_ADMIN_PERMISSION_KEYS.every((key) => heldGrantKeys.includes(key));
}

/** The stored snapshot of pre-enable grant keys (fail-open to empty). */
export function readAgentBoardAdminSavedGrantKeys(
  permissions: unknown,
): string[] {
  const record = asRecord(permissions);
  return asStringArray(record?.[AGENT_BOARD_ADMIN_SAVED_GRANT_KEYS]);
}
