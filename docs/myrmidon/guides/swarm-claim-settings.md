# Role queues (SWARM-CLAIM) settings

> Russian version: [swarm-claim-settings.ru.md](swarm-claim-settings.ru.md)

The pilot of the per-role task queues is controlled from the interface, without
restarting the board: who claims from a queue, how long a lease lives, how many
tasks one agent may hold, how often the sweep runs and whether a P0 task jumps
the queue. Since 1.6.1 every value is an instance setting.

## Where the settings live

Instance → General → **Role queues (SWARM-CLAIM)**. The screen writes
`instance_settings.general.swarmClaim` through `GET`/`PATCH /api/myrmidon/swarm-claim`
(any board member reads; an instance admin writes). The server re-resolves the
row on every claim, checkout, sweep tick and supervisor read — nothing is
cached at startup, no restart is ever needed.

## The fields

| Field | What it bounds | Default |
|---|---|---|
| Enable role queues | The master switch of the whole pilot | off |
| Pilot roles | Which roles claim. Comma-separated (e.g. `engineer`); empty = every role. The pilot on the dev team is exactly this field with one role | empty |
| Pilot companies | Which companies claim. Comma-separated ids; empty = every company | empty |
| Lease TTL, seconds | How long one lease lives without a heartbeat; the run refreshes it on every checkout pass | `900` |
| Max active tasks per agent | The ceiling of live claims per agent; empty = no ceiling | `3` |
| Sweep interval, seconds | How often the expired-lease sweep runs; read live, the startup value stays the floor | `30` |
| P0 preempts the queue | On — a `critical` task is the top of the queue. Off — strictly oldest-first | on |

## Where each value comes from

Every field shows its origin next to it — "Saved here", "Environment override"
or "Default" — and the Swarm supervisor screen (/swarm-claim)
shows the same for the values it renders. The `MYRMIDON_SWARM_*` environment
variables are **forced overrides**: a variable set in the process environment
beats the stored value for its key only (see [SETTINGS.md](../SETTINGS.md)).
Unset a variable to give control back to the UI.

## Turning the queues on for one role

The acceptance flow: set *Enable role queues* on, put `engineer` into *Pilot
roles* (and the company id into *Pilot companies* when several companies share
the instance), save. Within a minute a free engineer claims the top task of
the engineer queue on its next wake — the checkout writes the lease, the
finishing run releases it and wakes the next engineer of the role.

## Turning the queues off

Switching *Enable role queues* off (or forcing `MYRMIDON_SWARM_CLAIM_ENABLED=0`)
takes effect at once: the live leases are released synchronously — the save
response reports how many (`releasedClaims`) — and the sweep repeats the pass
on its next tick with the release reason `pilot_disabled`, covering anything
the synchronous pass could not reach. Runs holding released leases finish on
their own; the tasks return to vendor assignment behavior.

## The change journal

Every save appends a journal entry — who changed what, and when, newest
first — shown at the bottom of the section and kept under
`general.swarmClaimJournal` (capped at 50 entries). The same change also
writes an `instance.swarm_claim.updated` row into the activity log, which
stays the audit trail.
