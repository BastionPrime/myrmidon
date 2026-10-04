# WIP limit: the per-agent work-in-progress cap

> Russian version: [wip-limit.ru.md](wip-limit.ru.md)

The **WIP limit** caps how many tasks one agent may hold in flight at the
same time — `in_progress` plus `in_review`. The feature ships in two parts,
both merged: the server (part A) stores the settings, computes the live
status and raises the over-limit signal; the UI (part B, PR #415) is the
settings screen and the agent badge.

The settings screen lives in Company Settings → **WIP limit** (route
`/company/settings/wip-limit`, the sidebar item after **Autonomy**). The
live load shows up in three more places: a `wip/limit` badge on every agent
row of the agents page (the list view and the org view), an attention-feed
card per over-limit agent, and a system-notice comment on the agent's task.

## What "WIP" counts and what the limit does

`wip = inProgress + inReview` — the agent's visible in-flight tasks, counted
on the fly from the board's issue rows. An agent over its limit is flagged
for supervision; a run already in flight is never interrupted by the limit,
and no gate refuses a task to a capped agent — the limit is an attention
signal, not a block.

A limit that is `null` (absent) means **count only**: the status endpoint
keeps answering, the badge still shows, but no attention card and no comment
is ever raised for that agent. A company with no limit set at all runs the
whole feature count-only — even the periodic sweep stops before its first
query.

## The lead rule

An agent someone reports to (a `reportsTo` points at it) is a **lead**: its
implementation limit is 0 by definition, because a lead supervises and
accepts work rather than delivering it. A lead holding any task in progress
or in review is over the limit by definition — the attention card and the
system notice say so with the lead wording instead of quoting a number. The
reported `limit` still shows the settings value; only the over-limit check
uses the 0.

## The settings screen

Any company member reads the settings; an instance admin writes.

Two controls:

- **Default limit per agent** — one field. Applies to every agent without
  its own value. **Empty means count-only** (the placeholder says
  "No limit").
- **Per-agent limits** — one table row per agent of the company, sorted by
  name: the agent's name, its live load (read-only), and a **Limit** input.
  A row left empty (the placeholder reads "uses default") follows the
  default; typing a number overrides it just for that agent.

Accepted values: a whole number from `1` to `100` in the UI; the server
accepts `0..100` (a stored `0` counts as a hard zero — an agent with even
one task in flight is over the limit). Anything else is refused with a
message under the field, and the **Save WIP limit** button stays disabled
until every field is valid.

The live-load column ("In work now") reads the status endpoint and is
read-only on this screen. When a limit is set, each row shows the full
arithmetic — `in progress + in review = wip/limit`,
e.g. `2+1 = 3/4`; the
"Over limit" tag appears next to the load of an agent over its limit, and
the whole cell turns red. When the limit is off, the column shows the bare
`wip` count in muted gray. An agent with no status entry (not in the
response) shows an em dash.

**Save WIP limit** sends one PUT with the whole settings row. A save that
empties a per-agent field removes that agent's override from the stored
row — the agent falls back to the default. Saving also refreshes the live
load on both this screen and the roster.

State handling: with no company selected the screen says so and requests
nothing; while the settings load it shows "Loading the WIP limit
settings..."; a failed settings GET or PUT shows the error message in a red
box on the screen; a company with no agents shows "No agents in this
company yet." instead of the table.

## The badge on the agent roster

Every agent row on the agents page (both the list and the org view) can
carry a small pill next to the live-run indicator:

- with a limit set: `wip/limit` (e.g. `4/6`);
- over the limit: the same text in red with a dot, the tooltip "Over the
  WIP limit";
- with the limit off: just the bare `wip` number (no denominator), tooltip
  "Tasks in work (in progress + in review)";
- no badge at all when the status response has no entry for the agent.

The badge is read-only; the limit itself is edited on the WIP limit screen.

## The over-limit signal

Two surfaces carry the same over-limit fact:

- **The attention feed** (source kind `wip_limit`, severity `low`; `medium`
  for the lead rule) holds one card per over-limit agent, titled
  "<agent> is over its WIP limit" (or "…is a lead holding implementation
  work"), with two actions: **Inspect** and **Dismiss**. The feed recomputes
  on every list — the card exists exactly while the state holds and
  disappears the moment the count is back within the limit; nothing is
  persisted for it.
- **A system-notice comment** on the agent's most recent in-progress task,
  titled "WIP limit exceeded", written at most once per agent per UTC day —
  the dedup key `wip-limit:<agentId>:<utc-day>` rides in the comment's
  metadata. The comment states the count, the limit (or the lead rule) and
  the way out: finish or hand off tasks until the count is within the
  limit; a lead is told to hand the implementation task to an engineer and
  keep the task for review and acceptance.

The periodic check that writes those comments runs on the heartbeat
scheduler with an in-module interval of **300 s** (a pass whose previous run
is still going is skipped, not queued). The sweep reads the settings first:
no limit set anywhere means the pass stops before any query — the feature
never signals in count-only mode.

## The API surface

The routes are company-scoped under `/api/myrmidon`:

| Route | Purpose | Access | Body / response |
|---|---|---|---|
| `GET /myrmidon/companies/:companyId/wip-limit/settings` | read the settings row | any company member | `{ defaultLimit: number \| null, perAgent: Record<agentId, number \| null> }` |
| `PUT /myrmidon/companies/:companyId/wip-limit/settings` | write the settings row | instance admin | same shape |
| `GET /myrmidon/companies/:companyId/wip-limit/status` | live load per agent | any company member | `[{ agentId, inProgress, inReview, wip, limit, overLimit, leadRule }]` |

The settings are stored per instance in `instance_settings.general.wipLimit`
— there are no environment variables. An absent or unreadable stored row
normalizes to the count-only default (`defaultLimit: null`), so a
hand-edited value can never half-apply. `null` means "no limit"; an absent
`perAgent` key follows the default, an explicit `null` in `perAgent` means
count-only for that one agent.

## Questions an operator asks

**Does a limit interrupt a run in flight or block new tasks?** No. The limit
is a supervision signal: the badge, the attention card and the daily comment
surface the over-limit state; nothing gates the next task and nothing stops
a running one.

**How do I switch the feature off?** Empty the default field on the WIP
limit screen (and clear any per-agent values you set). With no limit set the
status keeps counting, the badge keeps showing, and no attention item or
comment is ever raised.

**Why is an agent with limit 4 flagged at 3 tasks?** Check whether it is a
lead — an agent with direct reports has an implementation limit of 0, so
any in-flight task flags it. The attention card's wording names the lead
rule when that is the cause.

**A comment repeats every day — how do I stop it?** The comment repeats at
most once per agent per UTC day while the state holds. It stops the moment
the agent's count is back within the limit (or the limit is removed), and
**Dismiss** on the attention card hides that card without touching the
count.
