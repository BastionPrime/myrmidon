// myrmidon(ADMIN-AGENT): the "Board administrator" toggle of the agent card
// Permissions section. The state comes from the agent detail API
// (`access.boardAdmin`, written back through `permissions.boardAdmin`); the
// change goes through the same PATCH /agents/:id/permissions call as the other
// permission flags, echoing the base flags unchanged alongside `boardAdmin`.
import { ApiError } from "@/api/client";
import type { AgentPermissionUpdate } from "@/api/agents";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export const BOARD_ADMIN_TOGGLE_TESTID = "board-admin-toggle";

export function boardAdminDeniedExplanation(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    if (/self/i.test(error.message)) return selfToggleExplanation();
    return error.message || "You do not have permission to manage board administrators.";
  }
  return error instanceof Error ? error.message : "Failed to update board administrator state.";
}

function selfToggleExplanation(): string {
  return "An agent cannot change its own board administrator state. Ask another board administrator to change it.";
}

/**
 * Availability rule (fixed here and pinned by tests):
 *
 * - The operator-facing access summary carries no explicit
 *   `users:manage_permissions` flag, so availability is derived from the
 *   operator's role in the company: `owner` and `admin` memberships hold the
 *   `users:manage_permissions` grant (see server role defaults), as does the
 *   local implicit board and any instance admin.
 * - An operator without that authority never sees the toggle: the section is
 *   hidden entirely.
 * - When the API still answers 403 (self-toggle, or a stricter server-side
 *   rule), a plain-language explanation is shown instead of the raw error.
 */
export function canManageBoardAdmins(input: {
  source?: string | null;
  isInstanceAdmin?: boolean | null;
  membershipRole?: string | null;
}): boolean {
  if (input.source === "local_implicit") return true;
  if (input.isInstanceAdmin === true) return true;
  return input.membershipRole === "owner" || input.membershipRole === "admin";
}

export function AgentBoardAdminSection({
  boardAdmin,
  pending,
  error,
  canManage,
  base,
  onSave,
}: {
  /** Current state from `access.boardAdmin` (falls back to `permissions.boardAdmin`). */
  boardAdmin: boolean;
  pending: boolean;
  error: string | null;
  /** Availability of the toggle for the current operator (see canManageBoardAdmins). */
  canManage: boolean;
  /** The three flags the permissions endpoint requires, echoed unchanged. */
  base: Pick<AgentPermissionUpdate, "canCreateAgents" | "canCreateSkills" | "canAssignTasks">;
  onSave: (update: AgentPermissionUpdate) => void;
}) {
  if (!canManage) return null;
  return (
    <div className="space-y-1 text-sm" data-testid="board-admin-section">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div>Board administrator</div>
          <p className="text-xs text-muted-foreground">
            Lets this agent administer the board: members, permissions and company settings.
            An agent cannot change this state for itself.
          </p>
        </div>
        <ToggleSwitch
          data-testid={BOARD_ADMIN_TOGGLE_TESTID}
          checked={boardAdmin}
          onCheckedChange={() => onSave({ ...base, boardAdmin: !boardAdmin })}
          disabled={pending}
        />
      </div>
      {error ? <p className="text-xs text-destructive" data-testid="board-admin-error">{error}</p> : null}
    </div>
  );
}
