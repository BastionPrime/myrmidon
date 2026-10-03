# LLM tracing health: the status card and the operator signal (TRACING-HEALTH)

> Russian version: [tracing-health.ru.md](tracing-health.ru.md)

LLM tracing (LiteLLM → Langfuse v4 over OTLP) can break silently: the 02.10
incident ran for days with the `traces` tables empty by design and a legacy
callback burning ~12k errors per hour, while the board showed nothing. The
health check (part C, the endpoint `GET /api/myrmidon/tracing/health`) makes
the pipeline's state computable; this guide covers its two board surfaces
(part D): where each one lives and what its states mean.

The check is off unless the tracing settings are set
(`MYRMIDON_TRACING_CLICKHOUSE_*` + the two `MYRMIDON_LITELLM_*` gateway
settings); see the variables and the health semantics in
[../SETTINGS.md](../SETTINGS.md). Both surfaces below read the same cached
report, so they always agree.

## The status card in Company settings

**Company settings** (route `/company/settings`) carries an "LLM tracing" card
below the Server console section. It is read-only: the operator fixes the
pipeline (the Langfuse v4 ClickHouse `events_core` store, the gateway
callbacks); the board only reports. The card fetches the report with
react-query and refreshes once a minute; a fetch error replaces the body with
the error text.

The card shows a colored dot with a state label, the reason line, one muted
line per evidence probe, and the check window:

| State | Label on the card | What it means |
|---|---|---|
| `ok` | green dot, `ok` | The gateway served traffic in the window, events landed in ClickHouse, and the callback error rate is ~0 |
| `idle` | green dot, `ok (idle)` | The gateway served no traffic in the window — a quiet period, not an alarm |
| `degraded` | red dot, `red` | Tracing is lost while traffic flowed, the delivery ratio is below 0.5, a legacy ingestion rejection landed, or the callback error rate is at or above 0.02 |
| `unknown` | red dot, `unknown` | A probe failed: the check itself cannot see the pipeline |
| not enabled | gray dot, `not enabled` | The tracing settings are unset; the endpoint answers 503 with `enabled: false` |

The reason line is the report's human explanation (for example "the gateway
served traffic but no tracing events landed in the window"). The evidence
lines are `gateway requests in window`, `events in window`,
`delivery ratio`, `callback error rate`, `legacy rejections` — a probe that
failed shows `unknown` instead of a number. The footer line shows the window
span (for example `window 15 min`) and the `checked` time of the last real
measurement.

## The operator signal

The card helps only when somebody opens the page. A periodic sweep
(`MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC`, default 300 s; off together with the
check itself) evaluates the same report in-process for every company and
raises ONE attention card on the operator desk:

- `degraded` → severity `high`: tracing is lost while traffic flows;
- `unknown` → severity `medium`: the check itself cannot see;
- `ok` / `idle` → no card. A quiet window is not broken.

The signal goes to the operator role, never to the task owner: fixing the
tracing pipeline is an operator's job, and the 02.10 incident burned exactly
because nobody whose job it was to look had a surface that looked. The card's
"why now" line names the pipelines to check (Langfuse ClickHouse
`events_core` and the gateway callbacks for `degraded`; the
`MYRMIDON_TRACING_*` / `MYRMIDON_LITELLM_*` probe configuration for
`unknown`).

Dedup is by state: one card (dedup key `tracing_health:llm-tracing`) while
the failure persists, and it disappears on its own as soon as the report
turns `ok` or `idle` — no dismissal bookkeeping. A manual dismiss also works
while the state persists.

## Activity log

The sweep writes one activity row per state TRANSITION only
(action `myrmidon.tracing.health_signal`, actor `tracing_health_sweep`): the
state, the severity and the reason are in the details. A steady red pipeline
does not spam the journal — one row when it turns red, one when it recovers.

## Related

- [../SETTINGS.md](../SETTINGS.md) — the `MYRMIDON_TRACING_*` variables, the
  probe TTL and the full health semantics.
- [../deploy.md](../deploy.md) — the install-time tracing guard and the
  release image pins (parts A and B).
