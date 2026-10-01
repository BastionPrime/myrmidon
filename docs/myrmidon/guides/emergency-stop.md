# Emergency stop for drained-pause runs

> Русская версия: [emergency-stop.ru.md](emergency-stop.ru.md)

Emergency stop is the operator's immediate lever for the runs a draining
pause left finishing. It exists since release 1.1.2 (plan item 2.2-17, board
row L3b-ES) and adds nothing to configure: no new environment variables, no
settings.

## Why it exists

Since L3 the operator pause drains by default (`MYRMIDON_PAUSE_DRAINS`, on
unless explicitly switched off): active runs keep running to completion, so a
pause does not manufacture a wall of recovery holds. That is the right default
for deploys and nights — but when a runaway agent must stop *now*, the only
immediate lever used to be `POST /agents/:id/pause` with `cancelActive: true`,
which also flips the agent's status and is not reachable from the board UI.
Emergency stop is the separate "stop the runs" action.

## Using it from the board

Open the agent's detail page. While the agent is paused **and** still has live
runs (`queued`, `running`, `scheduled_retry`), a banner on the page says how
many runs are still finishing and offers the **Emergency stop** button. The
button opens a confirmation dialog; confirming calls the stop route and a
toast reports how many runs were cancelled. The banner hides itself as soon as
no live runs remain or the agent is no longer paused — an active agent's live
runs are its normal work; pause first, then stop.

Banner strings are localized (`emergencyStopBanner.*` keys in every locale
file; the Russian translation is complete, other locales carry the English
base until translated).

## Using it through the API

```sh
curl -X POST https://board.example.com/api/myrmidon/agents/<agent-id>/emergency-stop \
  -H "Authorization: Bearer <board-api-key>"
```

The response reports the count:

```json
{ "agentId": "<agent-id>", "runsCancelled": 3 }
```

Access rules mirror the pause route: a board actor with access to the agent's
company and the `agents:create` grant. An agent's own API key gets 403; so
does a board member with read-only access. An unknown agent id and an agent
from another company both get an identical 404, so agent ids cannot be probed
across companies.

## What the stop does and does not do

- It cancels the agent's cancellable runs (`queued`, `running`,
  `scheduled_retry`) through the same `heartbeat.cancelActiveForAgent` call an
  explicit pause-cancel uses, with the same `agent_paused` error code — an
  infrastructure interruption, so no `legacy_execution_requires_reconciliation`
  hold and no immediate stranded-issue escalation (L1 behaviour, bounded retry
  budget).
- It does **not** change the agent's own status: a paused agent stays paused,
  an active agent stays active. Stopping the runs is separate from pausing the
  agent; combining the two is what the pause route's `cancelActive: true` is
  for.
- Cancelling is not undoable, but no work is lost: when the agent is resumed
  later, the affected tasks wake through the normal L3 resume path.
- Accepted race: because the route does not touch the agent's status, it can
  interleave with an unpause or a fresh wakeup landing at the same moment.
  Runs that start after the cancel snapshot are simply not cancelled — press
  the button again. Runs cancelled just before an unpause are resumed by the
  normal L3 path. Neither outcome loses work or corrupts state.

Every stop writes a `myrmidon.agent.emergency_stop` entry to the activity log
with the number of cancelled runs.

## Operator notes

- There is nothing to set up: no `MYRMIDON_*` variable and no flag gates the
  route or the banner. The draining behaviour that makes the stop useful is
  governed by `MYRMIDON_PAUSE_DRAINS` (see [../SETTINGS.md](../SETTINGS.md)
  and [../FLAGS.md](../FLAGS.md)); emergency stop itself works regardless of
  that setting, but only a draining pause leaves live runs behind on a paused
  agent.
- The board row is L3b-ES in [../DIVERGENCE.md](../DIVERGENCE.md); the route
  is mounted at `/api/myrmidon/agents/:id/emergency-stop` in
  `server/src/app.ts`, the module is `server/src/myrmidon/emergency-stop.ts`,
  the banner is `ui/src/components/myrmidon/EmergencyStopBanner.tsx`.
