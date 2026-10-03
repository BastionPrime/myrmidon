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
