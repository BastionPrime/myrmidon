# Board administrator: the agent-card toggle and the rights page

> Russian version: [agent-board-admin.ru.md](agent-board-admin.ru.md)

A **board administrator** is an agent the organization trusts with
board-administration authority: company members, roles, permission grants and
company settings. The board UI gives that state a face — a toggle in the
agent card and a visible row on the rights page (#411) — and the server gives
it the grant semantics (#443): the operator permission set the switch grants,
the snapshot of pre-existing grants, and the authorization rules for flipping
it. This guide covers all of it.

## Where the toggle lives

The **Permissions / Trust** tab of the agent card (the Governance block of the
agent card navigation, `/agents/<agent>/permissions`). Inside the bordered
**Permissions** box, below the three existing flags (**Can create new
agents**, **Can create/import skills**, **Can assign tasks**), the fourth row
reads **Board administrator** with the hint:

> Lets this agent administer the board: members, permissions and company
> settings. An agent cannot change this state for itself.

## What the toggle does

Flipping the toggle sends the same `PATCH /agents/:id/permissions` call the
three sibling flags use, with `boardAdmin` alongside the base flags. The state
the toggle shows comes from the agent detail API: the `access.boardAdmin`
value the server resolves, falling back to the stored
`permissions.boardAdmin` echo. Both readers are fail-closed: any non-`true`
value (absent, malformed, legacy) reads as **not** a board administrator, so
an old server or a stale cache never makes the UI show or flip admin
authority that is not there.

## The grant set behind the flag

The switch grants a fixed operator set — 17 permission keys listed as
`BOARD_ADMIN_PERMISSION_KEYS` in the shared constants
(`packages/shared/src/constants.ts`):

`agents:create`, `agents:configure`, `agents:suggest-changes`,
`skills:create`, `environments:manage`, `tools:admin`,
`tools:manage_connections`, `tools:manage_profiles`, `tools:view_audit`,
`tools:manage_runtime`, `tools:use`, `inbox:manage`, `users:invite`,
`users:manage_permissions`, `tasks:assign`, `tasks:assign_scope`,
`joins:approve`.

The list is written out explicitly rather than derived at runtime, so adding
a new key to the global permission registry never silently widens what an
existing board administrator holds.

**Enable** writes `permissions.boardAdmin = true`, snapshots the set keys the
agent already held into `permissions.boardAdminSavedGrantKeys`, and grants
every missing set key through the grant table. **Disable** writes
`permissions.boardAdmin = false`, clears the snapshot, and revokes only the
set keys the switch itself added — the saved snapshot survives: a personal
grant the agent held before the appointment (for example a separately issued
`tasks:assign`) stays. Re-enabling keeps the original snapshot, so keys issued
between disable and re-enable stay personal too.

`GET /agents/:id` resolves `access.boardAdmin` as `true` when the agent is
the company CEO, when the stored flag is set, **or** when the agent already
holds all 17 set keys — a read-time migration that covers pre-existing full
grant sets without rewriting them; the first toggle persists the explicit
flag and snapshot.

## Who may flip the switch

- A board actor needs the company `users:manage_permissions` right (the
  local implicit operator context and instance admins pass by definition). A
  cross-company request fails as 404, not 403.
- An agent actor needs the `users:manage_permissions` grant itself (the CEO
  rule stays) and **cannot grant board admin to itself** — a self-toggle
  answers 403. Note this also means an agent holding that grant may now
  manage other agents' permissions through the same PATCH.
- Every flip logs one `agent.permissions_updated` activity entry with the
  `boardAdmin` value and the acting principal.

## Who sees the toggle

The operator-facing access summary carries no explicit
`users:manage_permissions` flag, so availability is derived from the
operator's role in the company:

| Operator | Sees the toggle |
|---|---|
| Local implicit board | yes |
| Instance admin | yes |
| Company membership role `owner` | yes |
| Company membership role `admin` | yes |
| Membership role `operator` or `viewer` | no — the section is hidden entirely |

When the API still answers 403 (a self-toggle, or a stricter server-side
rule), a plain-language explanation appears under the toggle instead of the
raw error, e.g. for the self-toggle:

> An agent cannot change its own board administrator state. Ask another board
> administrator to change it.

## The rights page

The members page of Company Settings (**Members**, route
`/company/settings/members`, sidebar Company Settings → Members) now names
every agent board administrator. The members table renders one row per agent
whose status is not `terminated` and whose flag is true, above the
human-member rows: the agent's avatar and name (a link straight to the
agent's **Permissions** tab),
an em dash in the Email column, the agent's role label plus the outline badge
**Board administrator**, a status badge, and a **Permissions** link in the
Action column. Agents without the flag get no row; a terminated agent with
the flag stays out of the listing too. When no members and no agent admins
exist, the table shows the usual empty state; agent rows alone also suppress
it.

## Not shipped in part C

No UI surface exists for revoking or reviewing the grant keys the flag maps
to beyond this toggle, and the rights page shows no grant-level detail for
agent administrators — the role label and the badge are all it renders. The
agent card's permissions PATCH is the single write path; an operator can
still review an agent's individual grant rows through the access API.
