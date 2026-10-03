# The Myrmidon 2.0 shell behind `enableMyrmidonUi2` (UI 2.0)

> Russian version: [ui2-shell.ru.md](ui2-shell.ru.md)

Myrmidon 2.0 is a new interface for the board, built screen by screen in the
fork's own component tree (`ui/src/ui2/`). It runs in parallel with the 1.x
shell: the 2.0 frame replaces the navigation frame only, while every page and
route stays the page you already know. The switch is an instance flag,
`enableMyrmidonUi2`, off by default, with a per-browser personal override for
review. This guide is for operators and users of a self-hosted board: what the
flag does, how to turn the shell on and off, what changes on screen, and what
the design basis (tokens and fonts) is.

## What the flag does

`enableMyrmidonUi2` is an instance-level experimental setting (preference
tier). While it is off — the default — nothing changes: the 1.x shell renders
exactly as before, and no 2.0 code affects it. When it is on, the board route
tree renders inside the 2.0 frame instead of the vendor layout:

- the desktop rail, top bar and settings side panel replace the vendor
  sidebar;
- the mobile phone frame (header + five-tab bottom bar) replaces the vendor
  mobile navigation;
- the 2.0 screens re-skin the pages they cover (see below).

Everything behind the frame is shared with the 1.x shell: the same pages, the
same routes, the same data, the same access rules. Turning the flag off
restores the 1.x shell with no data or route changes.

The flag fails closed: while the settings request is in flight, on a settings
read error, and for stored settings rows written before the flag existed
(the key is missing), the board stays on the 1.x shell. The 2.0 shell is
strictly opt-in and never flashes on by accident.

## Turning it on instance-wide

1. Open the instance settings: Company settings → Instance → Experimental
   (route `company/settings/instance/experimental`, the "Experimental" tab of
   the instance settings page).
2. Toggle the card "Myrmidon UI 2.0 Shell".
3. Reload the board page. The 2.0 frame now renders for every user of the
   instance — subject to each browser's personal override (next section).

The toggle is the same experimental-settings card as every other instance
experimental flag; it writes `enableMyrmidonUi2` through
`PATCH /api/instance/settings/experimental` and applies without a restart —
the next page load picks it up.

## The per-user `?ui=1|2` override

Each browser can force a shell locally, without touching the instance flag:

- `?ui=2` on any board URL switches that browser to the 2.0 shell;
- `?ui=1` switches it back to the 1.x shell;
- the choice is remembered in that browser's `localStorage`
  (key `myr.ui2.personal`) and stays until the next `?ui=1|2` visit.

The personal override wins over the instance flag in both directions: an
operator can review the 2.0 shell with the flag still off, and any user can
stay on the 1.x shell while the flag is on. The override lives only in the
browser that set it — it is not a user setting on the server. To clear it,
visit any board URL with the other `?ui=` value.

This is the review path while 2.0 grows: flip the instance flag when you want
the whole instance on 2.0, and use `?ui=1` yourself to compare against the
1.x shell on the same deployment.

## What changes visually

Desktop (viewport width 768 px and up):

- A 232 px left rail with the Myrmidon logo, three groups of destinations —
  Observe (Command center, Server fleet, Swarm, Costs, Quality), Decide &
  talk (Wait for me, Commander), Manage (Settings) — a badge on "Wait for me"
  counting decisions awaiting the owner (99+ past ninety-nine), and an owner
  footer showing the company name and the active channel ("Web · now").
- A 56 px top bar: the nest switcher ("All nests" — today it states the
  scope; the multi-project selector arrives later), status chips — colony
  (running agents of total), Fleet (turns into "Fleet: 1 attention" when
  agents are in error or runs failed), and the month's spend of budget —
  and the "Tell the Commander" entry with a `Ctrl K` hint on it (the shortcut
  itself arrives with the 1.6 chat update; today the palette opens by click),
  and a navy decisions badge next to it.
- On company settings routes a 10-section settings side panel (General,
  Members, Access, Secrets, Runs and queue, Budgets, Autonomy, Guardrails,
  Castes and models, System).

Mobile (below 768 px): a phone frame — a 56 px header with the logo and
"Owner · Web" status, and a five-tab bottom bar (Command center / Wait for
me / Server fleet / Commander / More), tab items 60 px tall with touch
targets of at least 44 px.

Two shell parts are honest stubs for now:

- "Tell the Commander" opens a palette, but it is a stub: the message is not
  sent — the palette's action opens the existing board chat. The Commander
  conversation itself arrives with a later release.
- The 2.0 screens list below: each covered page is a real re-skinned 2.0
  screen (data from the existing endpoints); every other page renders inside
  the 2.0 frame unchanged, as the 1.x page.

The status chips and the decisions badge read the aggregates that already
exist (the dashboard summary and the sidebar badges) — no new server surface
is required for the shell.

## The 2.0 screens and what stays shared

The 2.0 screens re-skin these surfaces under the flag:

| 2.0 screen | Route | The 1.x surface it covers |
|---|---|---|
| Decisions | `decisions` | The decisions page |
| Costs | `activity/costs` | The costs page |
| Agent overview | `agents/:agentId/overview` | The agent card |
| Runs and queue (settings) | `company/settings/runs-queue` | Instance run limits |
| System (settings) | `company/settings/system` | Instance system settings |
| Language (settings) | `company/settings/language` | The UI language setting |

Every other page — tasks, agents, chats, the rest of company settings —
renders as the existing page inside the 2.0 frame. Routing, data and access
are unchanged in both cases: a 2.0 screen reads the same endpoints its 1.x
counterpart reads.

The six screens went from placeholder frames to real data surfaces in the
re-skin pass: each one loads its data through the same API calls its 1.x
counterpart uses (no new server endpoints, no backend changes). With the flag
off, every route serves the unchanged 1.x page — the screens live only under
the flag. With the flag on, the covered routes render the 2.0 screen; the
details per screen are below.

## What each 2.0 screen shows

- **Decisions** (route `decisions`) — the queue of open decisions that wait
  for you: filter chips (All / Policies / Money / External world), per-card
  options with the effect summary per option ("Effect"), inputs for options
  that need them, Decide and Dismiss (with an optional reason). The list
  refreshes every 30 seconds. A Decide sends the option, the input values and
  a generated idempotency key — the same action the 1.x page sends; a failed
  action shows the server's error message on the card. After a Decide or
  Dismiss, the queue, the "Wait for me" rail badge and the sidebar badges
  refresh. Fact-check rows, the recommendation and the "swarm decided"
  counters from the design artboards stay hidden until the API carries those
  fields.
- **Costs** (route `activity/costs`) — the spend summary, budget policies
  (window "lifetime" or "calendar_month_utc") with their status, incidents
  with the two resolution actions (`keep_paused`,
  `raise_budget_and_resume`), the paused-agents count, and the top agents by
  spend (twelve rows at most). A failed incident resolution shows the
  server's error next to the incident. The mock-only hierarchy
  (nest → caste → line), the forecast and the ticket limit stay hidden.
- **Agent overview** (route `agents/:agentId/overview`) — the agent's status,
  its policy (status `hard_stop`, `warning` or ok), recent runs from the last
  24 hours with cost, tokens and result, and the spend over the last 30 days.
  The vendor agent page is not rewritten: the existing page mounts this
  surface at its overview slot under the flag, and the actions (pause /
  resume, retire) stay on the vendor action bar. A missing agent renders a
  "no overview" note.
- **Runs and queue** (settings, route `company/settings/runs-queue`) — the
  four admission ceilings: `maxConcurrentRuns`, `maxStartsPerMinute`,
  `minFreeMemoryMb`, `runMemoryEstimateMb` (the last one cannot be turned
  off). Each row shows where its current value comes from (`settings`, `env`
  or `default`); a saved value applies without a restart, as in 1.x. The
  priority-class slots, per-class TTL/timeouts/retries, the pool-growth
  threshold and the hibernation rules are not in the API yet and stay hidden.
- **System** (settings, route `company/settings/system`) — members with
  roles and status, the board API keys (prefix, last use, revoked state) and
  the change log. The first slice is read-only: the artboard's per-entry
  "Rollback" buttons are not implemented (the API has no settings rollback),
  and the response-channel selector stays hidden.
- **Language** (settings, route `company/settings/language`) — the interface
  language switch (English / Russian) with a preview card showing a decision
  card in both languages side by side. The note holds: agent-written text
  (task bodies, run logs, comments) is never translated and identifiers
  never change. Number/date formats and the timezone belong to a later
  formats slice.

## Fail-closed states on the 2.0 screens

Every 2.0 screen ships the full set of state artboards — skeleton loading,
error with and without cached data, empty, and denied — so a screen never
shows partial numbers or half-loaded tables.

The denied state is the permission lock: when a screen's data request
answers `403`, the screen renders the lock alone — "This section needs board
access. Ask an operator for access; nothing is shown without it." — and no
data fragments. The screens that read instance-level surfaces (System,
Agent overview) render this lock on `403`; the other screens render the
generic error state with the server's message and a retry button on any
failed load. A screen with cached data keeps rendering it above the error
note; without cache the error replaces the list entirely.

## What the 2.0 screens do not have

- No client-side undo timer. Acting on a decision is final in the client:
  there is no countdown, no "Undo" button, no client-side hold after Decide
  or Dismiss. The server-side hold that the design artboards show is a later
  wave — until it ships, treat every Decide and Dismiss as executed
  immediately.
- No new server surface: every screen reads and writes through the existing
  endpoints its 1.x counterpart already uses.

The 1.x vendor screens have their own separate Russian-translation track
(the vendor `ui/src/i18n` locale files); the 2.0 tree carries its own
`ui2.*` string namespace. The 2.0 strings are translated in English and
Russian; the other 38 locales ship English values until a translation pass.

## The design-system basis: tokens and fonts

All visual values in the 2.0 tree come from the `--myr-*` token layer
(`ui/src/ui2/theme/tokens.css`), imported once from `ui/src/index.css`:
surfaces, ink, navy (the primary action color, `#13294B`), signal colors
(live, warn, halt — warn resolved to `#8A5300` on light and `#E6B450` on
dark), edges and focus rings (`#74849A`), radii, spacing, type scale, and
the frame
sizes (232 px rail, 56 px top bars, 60 px phone tab bar). The layer defines
light values on `:root` and dark values on `.dark` — the existing theme
class — so the 2.0 shell follows the board's light/dark mode. Some token
values are placeholders pending a design session; the shell is styled by the
same tokens either way.

Fonts are self-hosted subsets in `ui/public/fonts/myr2/` (SIL OFL, pinned
versions, no external requests at runtime):

- Saira — display font for Latin-script languages (headings, numbers, rail);
- Exo 2 — display font when the language is Russian (Saira has no Cyrillic);
  the switch is automatic on the `ru` language, and the Myrmidon wordmark
  stays Saira in every language;
- Inter — UI text (complements the vendor's Inter variable font for locale
  subsets);
- JetBrains Mono — logs, IDs, and money strings.

## Turning it off

Toggle the same card off (Company settings → Instance → Experimental →
"Myrmidon UI 2.0 Shell"), or `PATCH /api/instance/settings/experimental` with
`enableMyrmidonUi2: false`. The 1.x shell returns on the next page load; the
personal `?ui` override in a browser still wins over the off flag until
cleared with `?ui=1`.
