# Foraging: knowledge gathering from approved sources (1.6 FORAGING)

> Russian version: [foraging.ru.md](foraging.ru.md)

Foraging lets the colony collect fresh knowledge from approved external
sources and turn the changes into skill candidates. An operator registers
sources per role; a periodic sweep re-reads each enabled source, compares it
with the stored snapshot and records every change as a finding; a finding the
skill lifecycle accepts becomes a skill candidate and then goes through the
usual lifecycle approval before any agent sees it.

The module is `server/src/myrmidon/foraging/` (the 1.6 FORAGING path); the
screen is `/foraging`, a sidebar item next to Quality.

## Off by default

Foraging ships DISABLED. Without `MYRMIDON_FORAGING_ENABLED=1` no timer is
armed and no source is read; any other value keeps it off, so a typo cannot
turn the feature on. The registry and the findings list stay readable and
editable while the sweep is off: the screen shows a note that passes are not
running, and the manual sweep answers `503` with `enabled: false`.

## The source registry

Each company keeps its own registry (the `foraging_sources` table, migration
`0290`). One row is one source for one role: `role`, `url`, `kind` (`url`,
`feed`, `repo`, `docs`), `enabled`, plus the last snapshot, the timestamps of
the last snapshot and the last check, and the last error. One source per
`(company, role, url)` — saving the same role+url again updates the row.

## How a pass works

One sweep pass over one company:

1. Take the enabled sources, least recently checked first.
2. Read each source (a plain `GET`; the answer is capped at 512 KB, a larger
   answer is cut, not rejected).
3. Normalize the text into one trimmed line per element (empty lines dropped,
   duplicates collapsed, order ignored) and compare with the stored snapshot.
   The first read of a source stores the baseline and opens no findings.
4. A change (added or removed lines, up to 50 lines per side) becomes a
   finding in `foraging_findings` with a one-line summary and the target
   skill key `foraged-<role>`.
5. A finding becomes a skill candidate only through the candidate port — the
   seam with the skill lifecycle (SKILL-LIFECYCLE). While the port is absent
   the finding stays `unverified`; when the lifecycle is connected, an
   accepted finding becomes `candidate` with a link to the candidate, a
   refused one becomes `rejected` with the reason.
6. Stop the pass when the cost estimate reaches the budget ceiling
   (`stopped_by_budget`). The stop is a normal outcome: the sources after the
   stop stay untouched and the next pass continues with them.

A source that fails writes its error on the row and the pass continues; a
broken source never stops the sweep. A pass that overlaps the previous one is
skipped, not queued.

The read is the only place the feature talks to the outside, and it carries
its own rules: a pause between two reads of one host
(`MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC`, default 60 s), an honest
User-Agent (`myrmidon-foraging/1.0`), and a breaker that leaves a host alone
for 6 hours after two failures in a row. The pause and the breaker are shared
by every company of the process, so two roles pointing at one host cannot
double the rate. When `MYRMIDON_FORAGING_KEY_SECRET` names a company secret,
its value goes as a bearer token; the value is read at call time and is never
logged or stored.

## Settings

All settings are `MYRMIDON_FORAGING_*` environment variables (the full table
with bounds and defaults is in [../SETTINGS.md](../SETTINGS.md)):

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_FORAGING_ENABLED` | unset (off) | Master switch of the periodic pass; only the exact value `1` turns it on |
| `MYRMIDON_FORAGING_INTERVAL_SEC` | `3600` | Period of the pass, in seconds (60–86400) |
| `MYRMIDON_FORAGING_BUDGET_CENTS` | `50` | Per-pass cost ceiling in cents; a configured `0` or a negative number is the explicit «no limit» |
| `MYRMIDON_FORAGING_KEY_SECRET` | unset | **Name** of the company secret whose value is sent as a bearer token to the sources |
| `MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC` | `60` | Pause between two reads of one host, in seconds (5–86400) |

## The screen

The sidebar item «Foraging» (route `/foraging`) shows three things:

- the **source registry**, with an add form (role, url, kind), per-row state
  (last snapshot, last check, last error) and a delete button;
- the **findings** — each with the diff (`+N −M`), the summary, the target
  skill key, its state (`unverified` / `candidate` / `rejected`) and the
  candidate reference or the refusal reason;
- the **budget line** — the per-pass budget (or «no limit»), the estimated
  spend of the current UTC month, the pass interval and the same-host pause —
  plus a «Run sweep» button that starts one pass by hand (disabled while the
  feature is off).

The screen works while the sweep is off: the registry stays editable and the
findings stay readable, with a note that passes are not running.

## The API

All routes live under `/api/myrmidon/companies/:companyId/foraging`:

| Route | Who | What it does |
|---|---|---|
| `GET /sources` | company read | The registry plus whether the sweep is enabled |
| `PUT /sources` | board only | Adds or updates a source (`role`, `url`, `kind`, `enabled`) |
| `DELETE /sources/:sourceId` | board only | Removes a source |
| `GET /findings?limit` | company read | The findings, newest first (`limit` defaults to 50, maximum 200) |
| `GET /budget` | company read | The budget view for the screen |
| `POST /sweep` | board only | Runs one pass by hand; answers `503 {enabled: false}` while the sweep is off |

Reads need company access; the mutations need a board actor — the manual
sweep spends real external reads. Every mutation writes an activity-log row
(`myrmidon.foraging.source_saved`, `myrmidon.foraging.source_removed`,
`myrmidon.foraging.sweep_run`).

## From a finding to an agent

Nothing a source says reaches an agent directly. A finding with a diff goes
to the skill lifecycle through the candidate port; an accepted candidate
skill then follows the lifecycle rules (`candidate` reaches only the pilot
agents of `MYRMIDON_SKILL_PILOT_AGENTS`, promotion is approval-gated) and is
reviewed on the skill lifecycle screen (`/skills/lifecycle`) before it
reaches everyone.
