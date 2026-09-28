# Issue write lock (L5): live-run check and the manage-active-checkouts bypass

Redaction 28.09.2026. Scope: `issue_write_assignee_run_lock` (HTTP 409) on
`assertAgentIssueMutationAllowed` (`server/src/routes/issues.ts`).

## 0. Short version

- The lock used to fire off the issue's `status` alone: any `in_progress` issue blocked every
  other agent's write, even with no run actually going. It now only fires when the assignee's
  checkout or execution run is itself still `running` or `queued`.
- No live run → the write proceeds (the boundary above it, `issue:mutate`, still applies) and an
  activity-log row (`issue.write_lock_bypassed_no_live_run`) records who wrote into whose issue.
- `tasks:manage_active_checkouts` keeps bypassing the lock entirely, live run or not. This
  permission is vendor machinery, unchanged by L5 — section 2 below is about *granting* it, not
  about anything L5 added.
- `MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN` (default `1`) reverts to the pre-L5 status-only lock
  when set to `0`.

## 1. Why "in_progress" was not "a run is live"

An issue's `status` moves to `in_progress` on checkout and stays there until the assignee moves
it elsewhere. A run behind that checkout can end — succeed, fail, get cancelled, time out — while
the issue itself is left `in_progress` for any number of reasons: a parent task whose only
"in_progress" signal is inherited from a child, a recovery path that has not yet resolved the
issue's terminal state, or simply the gap between a run ending and whatever process would move
the issue on. In every one of those windows, the assignee has no run going, but every other
agent's write to that issue still hit the 409 whose copy said "a run is live" — untrue by
construction.

The fix (`server/src/myrmidon/issue-write-run-lock.ts`) resolves the issue's `checkoutRunId` /
`executionRunId` against `heartbeat.getRun(...)` and only reports the lock as live when that
run's `status` is `running` or `queued`. `queued` counts: an admission-limited run
(`server/src/myrmidon/run-admission.ts`) waiting for a slot still owns the issue, it just has not
started executing yet.

## 2. `tasks:manage_active_checkouts` — how to grant it, config only

This permission already lets its holder write to *any* agent's issue regardless of the run lock
(`server/src/services/authorization.ts`, `assertAgentIssueMutationAllowed`'s override check,
evaluated before the live-run check — L5 does not touch this path). Two ways an agent ends up
holding it, both vendor mechanism, no code:

1. **Manager chain — usually already true, zero config.** `authorization.ts`'s
   `allow_manager_chain` decision grants it automatically to any agent that manages the issue's
   assignee in the reporting chain (`isManagerOf`, walks `agents.reportsTo`). If the director's
   agent card already lists the subordinate (directly or transitively) under `reportsTo`, they
   already have the override — this is almost certainly true for the "director writes to a
   subordinate's parent task" case the L5 fix was raised for. Nothing to configure.
2. **`ceo` role — already true, zero config.** `authorization.ts` grants the override to any
   agent whose `role` is `ceo`, unconditionally (`allow_legacy_agent_creator` reason, same
   pre-existing check as legacy agent creation).
3. **Explicit grant — for a director outside the reporting chain.** The vendor's generic
   permission-grant table (`principal_permission_grants`, service function
   `accessService(db).setPrincipalPermission`) accepts any key from `PERMISSION_KEYS`
   (`packages/shared/src/constants.ts`), and `tasks:manage_active_checkouts` is one of them — the
   authorization boundary checks this table (`decidePrincipalGrant`) before falling through to
   the manager-chain/CEO special cases. There is, however, **no dedicated UI toggle or REST field
   for this specific key** today: `PATCH /api/agents/:id/permissions`
   (`updateAgentPermissionsSchema`) only exposes `canCreateAgents`, `canCreateSkills`,
   `canAssignTasks`, `trustPreset`, `authorizationPolicy` — `tasks:assign` is the only permission
   key with its own boolean (`canAssignTasks`). Granting `tasks:manage_active_checkouts` to an
   agent that is neither the assignee's manager nor a CEO therefore means writing one row, not
   shipping a route: a company operator upserts

   ```
   principal_permission_grants(company_id, principal_type='agent', principal_id=<director agent
     id>, permission_key='tasks:manage_active_checkouts', scope=NULL)
   ```

   e.g. by calling `accessService(db).setPrincipalPermission(companyId, "agent",
   directorAgentId, "tasks:manage_active_checkouts", true, grantedByUserId)` from an operator
   console, the same function the vendor's own `tasks:assign` toggle calls. This is vendor
   surface, not something L5 adds — flagged here only because operations asked how to reach it
   without a code change. If this permission turns out to need its own UI toggle, that is new
   work outside L5's scope (note it as a follow-up, not part of this fix).

## 3. What L5 did not change

- The `issue:mutate` boundary decision (`decideIssueAccess`), evaluated before any of this,
  still gates whether the actor may write to the company's issues at all.
- The idle-issue path (`status !== "in_progress"`) and its `options.allowVisibleIssueWrite` gate
  are untouched — L5 only changes what happens once `status === "in_progress"`.
- Same-assignee writes (`issue.assigneeAgentId === actorAgentId`) still go through
  `requireAgentRunId` + `svc.assertCheckoutOwner`, unchanged.
- The task-watchdog scoped grant (evaluated even earlier) is unchanged.

## 4. Setting

See `docs/myrmidon/SETTINGS.md`, track 3 — `MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN`.
