// @vitest-environment jsdom
//
// myrmidon(ADMIN-AGENT): the board administrator toggle of the agent card.
//
// Pins, per the acceptance points:
//   1. the toggle shows the state from the API (access.boardAdmin with the
//      permissions echo as fallback) and sends `boardAdmin` in the PATCH body
//      (mocked updatePermissions);
//   2. an operator without permission-management authority never sees the
//      toggle (the section is hidden, fixed in canManageBoardAdmins);
//   3. a 403 from the API becomes a plain-language explanation (self-toggle).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  AgentBoardAdminSection,
  BOARD_ADMIN_TOGGLE_TESTID,
  boardAdminDeniedExplanation,
  canManageBoardAdmins,
} from "./AgentBoardAdminSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base = { canCreateAgents: false, canCreateSkills: true, canAssignTasks: false };

function render(props: Partial<Parameters<typeof AgentBoardAdminSection>[0]> = {}) {
  const onSave = props.onSave ?? vi.fn();
  act(() => {
    root.render(
      <AgentBoardAdminSection
        boardAdmin={props.boardAdmin ?? false}
        pending={props.pending ?? false}
        error={props.error ?? null}
        canManage={props.canManage ?? true}
        base={props.base ?? base}
        onSave={onSave}
      />,
    );
  });
  return { onSave };
}

function toggle() {
  return container.querySelector<HTMLElement>(`[data-testid="${BOARD_ADMIN_TOGGLE_TESTID}"]`);
}

describe("myrmidon(ADMIN-AGENT) board admin toggle", () => {
  it("reflects the API state and sends boardAdmin in the PATCH payload", () => {
    const { onSave } = render({ boardAdmin: true });
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    act(() => toggle()?.click());
    expect(onSave).toHaveBeenCalledWith({ ...base, boardAdmin: false });

    const { onSave: off } = render({ boardAdmin: false });
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    act(() => toggle()?.click());
    expect(off).toHaveBeenCalledWith({ ...base, boardAdmin: true });
  });

  it("hides the section for an operator without permission-management authority", () => {
    const { onSave } = render({ canManage: false });
    expect(container.querySelector('[data-testid="board-admin-section"]')).toBeNull();
    expect(toggle()).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a plain-language explanation when the API answers 403", () => {
    render({ error: boardAdminDeniedExplanation(new ApiError("Agents cannot change their own board administrator state", 403, {})) });
    expect(container.querySelector('[data-testid="board-admin-error"]')?.textContent).toContain(
      "own board administrator state",
    );
    // The raw passthrough case: a generic 403 still yields a readable message.
    expect(boardAdminDeniedExplanation(new ApiError("Missing permission: users:manage_permissions", 403, {}))).toContain(
      "users:manage_permissions",
    );
  });

  it("availability rule: only owner/admin roles, instance admins and the local implicit board", () => {
    expect(canManageBoardAdmins({ membershipRole: "owner", source: "session", isInstanceAdmin: false })).toBe(true);
    expect(canManageBoardAdmins({ membershipRole: "admin", source: "session", isInstanceAdmin: false })).toBe(true);
    expect(canManageBoardAdmins({ source: "local_implicit", isInstanceAdmin: null, membershipRole: null })).toBe(true);
    expect(canManageBoardAdmins({ source: "session", isInstanceAdmin: true, membershipRole: null })).toBe(true);
    expect(canManageBoardAdmins({ membershipRole: "operator", source: "session", isInstanceAdmin: false })).toBe(false);
    expect(canManageBoardAdmins({ membershipRole: "viewer", source: "session", isInstanceAdmin: false })).toBe(false);
    expect(canManageBoardAdmins({ membershipRole: null, source: "session", isInstanceAdmin: false })).toBe(false);
  });
});
