# Agent actors with permission grants: environments and tool connections

> Русская версия: [actor-grant-routes.ru.md](actor-grant-routes.ru.md)

Some routes that were board-only now admit **agent actors** when the company
grants the agent the matching permission. This guide lists exactly which
routes changed, which permission key each route requires, what an agent actor
without the grant sees, and how the board actor path is unchanged.

This is the ADMIN-AGENT umbrella, part B (grant-based actor permission
checks), merged in PR #412 for release 1.6.1.

## How the check works

All changed routes delegate to one helper,
`assertActorCompanyPermission` in `server/src/routes/authz.ts` (or its
per-file twins `assertBoardToolPermission` / `assertBoardAnyToolPermission` in
`tool-access.ts` and `assertBoardPermission` in `tool-gateway.ts`, which
follow the same shape):

- Company access is still asserted first: an agent key of another company
  fails exactly as before (`Agent key cannot access another company`).
- A **board actor** keeps the previous behavior: local implicit board and
  instance admins pass, a signed-in member passes with the grant via
  `access.canUser`, viewers stay read-only on mutations, and `local_implicit`
  bypasses the grant check.
- An **agent actor** passes when the company grants the agent that permission
  key (`access.hasPermission(companyId, "agent", agentId, key)`); without the
  grant the route answers `403` with `Missing permission: <key>` (or
  `Missing one of permissions: …` where any of several keys is enough).

A grant is a row in the `principal_permission_grants` table — the same table
the company rights page uses for user members. Agents are members too
(`principalType: "agent"`): an operator grants an agent a permission from the
board UI the same way as for a user member, or via
`PATCH /api/companies/:companyId/members/:memberId/permissions` with a
`grants` array. That route itself is gated by `users:manage_permissions` and
replaces the grantee's whole grant set atomically, so call it with the full
desired list, not just the new key.

## Routes and required permission keys

### Environments (`server/src/routes/environments.ts`)

The instance environments and custom-image routes use three guards; an agent
actor that resolves a `companyId` context passes with the key:

| Guard | Applies to | Agent rule |
|---|---|---|
| `assertCanAccessInstanceEnvironments` | instance environment management and mutation routes (`POST /api/companies/:companyId/environments`, `PATCH`/`DELETE /api/environments/:id`, probes, custom-image setup sessions, rollback) | own company + `environments:manage`; an agent with **no** company context is rejected as before (instance environment management stays board-operator territory) |
| `assertCanReadInstanceEnvironments` | the read surfaces (`GET /api/companies/:companyId/environments` and aliases) | own company + `environments:manage`; without a company context the agent falls back to the same rejection as before |
| `assertCustomImageCompanyAccess` | custom-image template reads/writes scoped to a company | own company + `environments:manage` |

Reading the company environment list
(`GET /api/companies/:companyId/environments`) now requires the
`environments:manage` grant for agent actors — it enumerates the shared
instance environment catalog, so an agent without the grant gets `403` there
too.

A board actor is unchanged: instance environment management still requires
instance admin (or local implicit board) for mutations, and board members with
company access can read as before.

### Tool connections (`server/src/routes/tool-access.ts`)

| Guard | Required key(s) |
|---|---|
| `assertToolsAdmin` (`tools:admin`) | `GET`/`POST /api/companies/:companyId/tools/stdio-templates` (approved stdio command templates and their disable route) |
| `assertToolsRuntimeManage` (`tools:manage_runtime`) | `GET /api/companies/:companyId/tools/runtime-slots`, `POST …/runtime-slots/:id/stop`, `POST …/runtime-slots/:id/restart` |
| `assertBoardAnyToolPermission` (any of) | `GET /api/tool-connections/:connectionId/test-agents` and the other connection test routes: `tools:use` **or** `tools:manage_connections` |
| `assertBoardToolPermission` (`tools:manage_connections`) | the connection manager gate used where the connection-configure path checks the grant |

Other connection routes keep their existing membership/role logic for board
actors and stay board-only for mutations unless listed above; an agent's own
connection lifecycle routes (`/agents/me/connections/…`) are not affected by
this change.

### Tool gateway (`server/src/routes/tool-gateway.ts`)

The gateway's board-permission guard covers the raw gateway control surfaces:

| Route | Required key |
|---|---|
| `GET /api/tool-gateway/runtime-slots` | `tools:manage_runtime` |
| `POST /api/tool-gateway/runtime-slots/:slotId/stop` | `tools:manage_runtime` |
| `POST /api/tool-gateway/runtime-slots/:slotId/restart` | `tools:manage_runtime` |
| `GET /api/tool-gateway/audit` | `tools:view_audit` |
| `GET`/`POST /api/companies/:companyId/tools/gateways`, `PATCH /api/tool-gateway/gateways/:gatewayId`, token create/revoke | `tools:admin` |

Before this change an agent actor got `Board access required` on all of these;
now an agent with the matching grant passes, and an agent without it gets
`403 Missing permission: <key>`.

## Activity log attribution

Tool connection mutations (`tool_connection.*`, `tool_application.*`,
`paperclip_cloud_connector.*`, `tool_stdio_command_template.*`,
`tool_app.*` actions) now record the **real acting principal** instead of the
hardcoded `user` / `req.actor.userId ?? "board"` placeholder: an agent-actor
mutation writes `actorType: "agent"` with the agent id and run id, so an
agent-made change is attributable in the company activity log. Previously the
row claimed a board user made the change.

## Operator notes

- The board row is the ADMIN-AGENT part B entry in
  [../DIVERGENCE.md](../DIVERGENCE.md).
- Grants are set per member from the company rights page; the permission keys
  are the vendored `PERMISSION_KEYS` list (`environments:manage`,
  `tools:admin`, `tools:manage_connections`, `tools:manage_profiles`,
  `tools:manage_runtime`, `tools:view_audit`, …).
- Fail-closed: an agent without any grant sees exactly the old behavior
  (403), so enabling nothing changes nothing.
- The agent must act with its own company key: cross-company calls fail the
  company access check before the grant check.
