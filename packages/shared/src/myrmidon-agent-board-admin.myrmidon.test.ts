import { describe, expect, it } from "vitest";
import {
  AGENT_BOARD_ADMIN_PERMISSION_KEY,
  AGENT_BOARD_ADMIN_SAVED_GRANT_KEYS,
  BOARD_ADMIN_PERMISSION_KEYS,
  deriveBoardAdminFromGrants,
  boardAdminRevocableGrantKeys,
  missingBoardAdminGrantKeys,
  readAgentBoardAdmin,
  readAgentBoardAdminPermission,
  readAgentBoardAdminAccess,
  readAgentBoardAdminSavedGrantKeys,
} from "./myrmidon-agent-board-admin.js";
import { updateAgentPermissionsSchema } from "./validators/agent.js";
import { PERMISSION_KEYS, type PermissionKey } from "./constants.js";

// myrmidon(ADMIN-AGENT): the shared contract of the board-admin toggle — the
// operator set, the stored flag readers, and the grant bookkeeping helpers.

describe("board admin shared contract", () => {
  it("defines the operator set as a subset of PERMISSION_KEYS", () => {
    expect(BOARD_ADMIN_PERMISSION_KEYS.length).toBe(17);
    for (const key of BOARD_ADMIN_PERMISSION_KEYS) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it("accepts the optional boardAdmin flag in updateAgentPermissionsSchema", () => {
    expect(updateAgentPermissionsSchema.safeParse({
      canCreateAgents: false,
      canAssignTasks: true,
      boardAdmin: true,
    }).success).toBe(true);
    expect(updateAgentPermissionsSchema.safeParse({
      canCreateAgents: false,
      canAssignTasks: true,
    }).success).toBe(true);
    expect(updateAgentPermissionsSchema.safeParse({
      canCreateAgents: false,
      canAssignTasks: true,
      boardAdmin: "yes",
    }).success).toBe(false);
  });

  it("reads the flag and the snapshot from a stored permissions record", () => {
    expect(readAgentBoardAdminPermission({ [AGENT_BOARD_ADMIN_PERMISSION_KEY]: true })).toBe(true);
    expect(readAgentBoardAdminPermission({})).toBe(false);
    expect(readAgentBoardAdminPermission(null)).toBe(false);
    expect(readAgentBoardAdminSavedGrantKeys({
      [AGENT_BOARD_ADMIN_SAVED_GRANT_KEYS]: ["tasks:assign"],
    })).toEqual(["tasks:assign"]);
    expect(readAgentBoardAdminSavedGrantKeys({})).toEqual([]);
    expect(readAgentBoardAdminSavedGrantKeys(null)).toEqual([]);
  });

  it("derives board admin from the full operator set (read-time migration)", () => {
    expect(deriveBoardAdminFromGrants(BOARD_ADMIN_PERMISSION_KEYS)).toBe(true);
    expect(deriveBoardAdminFromGrants([...BOARD_ADMIN_PERMISSION_KEYS, "tools:use" as PermissionKey])).toBe(true);
    const partial = BOARD_ADMIN_PERMISSION_KEYS.slice(0, 16);
    expect(deriveBoardAdminFromGrants(partial)).toBe(false);
    expect(deriveBoardAdminFromGrants([])).toBe(false);
  });

  it("computes missing and revocable keys against a snapshot", () => {
    expect(missingBoardAdminGrantKeys(["tasks:assign"])).toEqual(
      BOARD_ADMIN_PERMISSION_KEYS.filter((key) => key !== "tasks:assign"),
    );
    // Disable revokes only the set keys the switch added: the pre-existing
    // tasks:assign grant survives.
    expect(
      boardAdminRevocableGrantKeys(BOARD_ADMIN_PERMISSION_KEYS as readonly string[], ["tasks:assign"]),
    ).toEqual(BOARD_ADMIN_PERMISSION_KEYS.filter((key) => key !== "tasks:assign"));
    expect(boardAdminRevocableGrantKeys([], [])).toEqual([]);
    // Keys outside the operator set are never revocable.
    expect(boardAdminRevocableGrantKeys(["tasks:assign", "pipelines:write"], [])).toEqual([
      "tasks:assign",
    ]);
  });

  it("keeps the fail-closed UI readers", () => {
    expect(readAgentBoardAdminAccess({ boardAdmin: true })).toBe(true);
    expect(readAgentBoardAdminAccess({ boardAdmin: "yes" })).toBe(false);
    expect(readAgentBoardAdmin({ permissions: {}, access: { boardAdmin: true } })).toBe(true);
    expect(readAgentBoardAdmin({ permissions: { boardAdmin: true } })).toBe(true);
    expect(readAgentBoardAdmin({})).toBe(false);
  });
});
