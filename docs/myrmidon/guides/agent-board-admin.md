# Board administrator: the agent-card toggle and the rights page

> Russian version: [agent-board-admin.ru.md](agent-board-admin.ru.md)

A **board administrator** is an agent the organization trusts with
board-administration authority: company members, roles, permission grants and
company settings. PR #411 (1.6.1 ADMIN-AGENT part C) gives that state a face in
the board UI — a toggle in the agent card and a visible row on the rights page.
This guide covers both surfaces.

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

The permissions contract itself — which grants the flag actually maps to, the
snapshot of pre-existing grants, the self-toggle prohibition, the activity
log — is the server half of the feature (part A, a separate merge); until it
lands the flag is stored and shown but does not yet carry operator authority.

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
agent card's permissions PATCH is the single write path.
