# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

## 1.6.0

### CTO chat planner (CTO-CHAT B)

- The board chat planner: one owner message in free text
  (`POST /api/myrmidon/cto-chat/plan`, or the same planning step entered from
  the owner's Telegram DM bridge) becomes a proposed epic with child tasks and
  per-task acceptance criteria. The proposal is shown as the board's existing
  `suggest_tasks` approval card on the standing conversation task, and
  accepting the card is what creates the issues — nothing exists before
  acceptance, no assignee is inferred, and a rejected or expired card creates
  nothing. The planner is off unless `MYRMIDON_CTO_CHAT_BASE_URL` and
  `MYRMIDON_CTO_CHAT_KEY_SECRET` are set; the gateway key is a company secret
  read per call and never logged. The default model is the free
  `dashscope-qwen-flash`; one proposal is capped at 8 child tasks (hard
  ceiling 20) and one planning call is never retried. Operator guide:
  [guides/cto-chat-planner.md](guides/cto-chat-planner.md). The portal chat
  screen (part A) ships separately and calls the same route.

## 1.5.0

### Tracing health (TRACING-HEALTH)

- The "LLM tracing" status card in Company settings and the operator attention
  signal: the board reads the health report of the LiteLLM → Langfuse v4
  tracing pipeline (`GET /api/myrmidon/tracing/health`, part C) and surfaces
  it two ways. The card (below the Server console section) shows the dot and
  state (`ok` / `ok (idle)` / `red` / `unknown` / `not enabled`), the reason
  line, one null-aware line per evidence probe and the window span, refreshing
  once a minute. A periodic sweep (`MYRMIDON_TRACING_SIGNAL_INTERVAL_SEC`,
  default 300 s, off with the check itself) evaluates the same report for
  every company and raises ONE attention card on the operator desk —
  `degraded` is high, `unknown` is medium, `ok`/`idle` raise nothing; the
  signal goes to the operator role, never the task owner. Dedup is by state:
  recovery clears the card without dismissal bookkeeping, and the journal gets
  one activity row per state transition only. Guide:
  [guides/tracing-health.md](guides/tracing-health.md).

### Client connectors (the browser bridge)

- The client connector gateway (EXTCASE-B): the board accepts an outbound
  WebSocket connection (`/bridge/v1`, JSON-RPC 2.0) from a browser extension on
  a client PC — the transport for platforms that exist only in the client's
  browser behind a local signing key. Pairing is a one-shot 15-minute code
  exchanged for a device-bound bridge token (only HMAC digests are stored,
  peppered by `MYRMIDON_BROWSER_BRIDGE_PEPPER`); revocation is fail-closed and
  drops the live socket. Every action is gated by the declared capability set
  and the company domain allowlist (checked at the gateway and again in the
  extension) and journaled — one row per action in the company activity log,
  page content never journaled. Signing follows the operator policy
  (`general.browserBridge.signing`: `enabled` / `auto` / `manual` / `types`)
  with a one-call emergency off; the signed bytes and the PIN never leave the
  client PC — the journal holds the document hash. Guide:
  [guides/browser-bridge-gateway.md](guides/browser-bridge-gateway.md).
- The connector panel (EXTCASE-PANEL), Company settings → Connectors: the
  device list with online status and capabilities, one-shot pairing codes shown
  once, revocation with confirmation, the domain allowlist, the signing policy
  with a daily signature limit per UTC day (the gateway refuses before the
  device is asked, `dailyLimitReached`) and the emergency stop, plus the bridge
  journal with filters (device, method, outcome, signatures only) and the
  document hash per signature. Guide:
  [guides/connector-panel.md](guides/connector-panel.md).
- The signing host contract: a generic, client-free native-messaging contract
  for local signing helpers (`extension/src/native-host-contract.ts`) — a
  closed `actionType` enum (`sign` / `sign_and_submit` / `sign_attachment`), a
  document payload of bytes or a SHA-256 digest, a closed error-code set, and
  validators both sides compile against. A concrete helper (token middleware
  binding, PIN storage) is deployment-specific and lives outside the public
  fork. Guide:
  [guides/signing-host-contract.md](guides/signing-host-contract.md).

### OCR path

- `ocr.pdf` for every bot (EXT-CASE-OCR): a PDF received as a mail attachment
  or downloaded through the bridge is recognized into text in the bot
  workspace, with a structural excerpt for tender documentation (requirements,
  deadlines, positions). Backends: RAGFlow (MCP) or an OpenAI-compatible
  gateway (LiteLLM), selected by `MYRMIDON_OCR_BACKEND`; refusals carry stable
  codes and happen before the backend is contacted (size and page ceilings).
  The journal holds metadata only — never the text or the bytes. Guide:
  [guides/ocr.md](guides/ocr.md).

### External MCP connectors

- Any standards-compliant HTTP MCP server now plugs in without fork code
  through the vendor's generic connection surface (Apps → Connect an app →
  Connect your own MCP server, or Apps → Advanced → Paste a config):
  credentials become company secrets, per-agent grants default to deny, and
  tools arrive namespaced `mcp.<connection>:<tool>`. The operator runbook —
  entry points, grants, health checks, rotation:
  [guides/external-mcp-connectors.md](guides/external-mcp-connectors.md).

### UI 2.0 shell (flagged, UI-0a)

- The Myrmidon 2.0 shell behind the instance flag `enableMyrmidonUi2`
  (default off, Instance settings → Experimental → "Myrmidon UI 2.0 Shell"):
  a clean-room tree `ui/src/ui2/` — the 232px left rail, the top bar with the
  nest switcher, status chips and the "Tell the Commander" entry, and the
  390px phone frame (56px header + five-tab bottom bar). The 2.0 design-system
  tokens (`--myr-*`, light and dark) and the self-hosted Saira / Exo 2 / Inter /
  JetBrains Mono subsets land with it. Pages and routes stay shared with the
  1.x shell; turning the flag off restores it. The rail badge and status chips
  read the existing dashboard and sidebar-badges aggregates until the
  STATUS-STRIP endpoint exists. i18n keys `ui2.*` ship in en/ru (translated)
  and the other locales (English values until the translation pass).

### Task PR sync

- A task delivered by a pull request settles itself once its PRs merge
  (#315): a periodic sweep (`server/src/myrmidon/task-pr-sync/`, ships
  enabled) reads the task's own `pull_request` work products, refreshes each
  PR's state through the existing GitHub resolver, and closes the task with
  one neutral comment (PR refs, merge sha, time) when every PR is terminal
  with at least one merged and no post-deploy gate (a pending card, a pending
  approval or a future-scheduled monitor) is still open. Closed-without-merge
  PRs send the task back to its assignee; superseded PR rows are ignored. And
  the wake guard half (#339, post-1.5.0): an event-free wake to such a
  settle-pending task is skipped (reason `wake_skipped_pr_settle_pending`)
  instead of dispatching a run that would only race the settle. Operator
  guide: [guides/task-pr-sync.md](guides/task-pr-sync.md).

## 1.4.0

Everything merged between the 1.3.2 and 1.4.0 tags. Deploy this release's board,
dockergate and fleetd images together (see [deploy.md](deploy.md#deploy-the-board-and-the-release-components-together)).

### Memory and isolation

- "Memory" tab on the agent card (MEMORY-UI, plan 1.4 item 1): view, export (JSON)
  and removal of the entries of the agent's memory bank — resolved by the same bank
  rule the memory plugin fork applies. Removing one entry is reversible (invalidation
  with a reason); clearing the whole bank sits behind a typed confirmation; every
  action writes an activity log row. The section is enabled by the
  `MYRMIDON_HINDSIGHT_API_URL` + `MYRMIDON_HINDSIGHT_KEY_SECRET` pair.
  Guide: [guides/agent-memory-card.md](guides/agent-memory-card.md) (#258, #265).

### Cloud storage

- CLOUD-CONNECTOR part B: the owner connects a cloud from the panel — the connector
  builds the provider's authorization URL with a single-use state and PKCE, exchanges
  the code, and keeps the resulting token bundle in a company secret of the instance
  secret store. Only the secret id stays in the connector's own state, so no bot ever
  holds a cloud token and the token value never travels through the panel API (#252).

### Deploy and reliability

- Automatic rollback by health for the board and the bot fleet (R5-C). A failed
  health check after a deploy no longer leaves the board or the touched bots on the
  broken image. Board: the job moves to `rolling_back` and the host executor runs
  `rollback.sh` to the image the deploy remembered before the switch; the job ends
  `auto_rolled_back` (maintenance window closed) or `failed_rollback` (window kept
  for the operator). Bots: a failed canary or wave bot moves the rollout to
  `rolling_back`; every bot that received the new image gets its own card image
  re-applied, one at a time, and the rollout ends `rolled_back` with the original
  failure reason kept. Switches (both on by default): `MYRMIDON_DEPLOY_AUTO_ROLLBACK`
  for the board, `MYRMIDON_BOT_CANARY_AUTO_ROLLBACK` for the fleet; the host side
  of the board switch is `AUTO_ROLLBACK` in `deploy.env`, both sides must agree.
  Unattended auto-update stays off (`MYRMIDON_DEPLOY_AUTO_UPDATE=0`); see
  [SETTINGS.md](SETTINGS.md) (#261).
- Heartbeat: a queued-run start that re-enters the agent start lock no longer waits
  for itself. The lock body now runs in an async-context frame per agent, so a
  nested start from the same chain skips the wait and no longer stalls for
  `AGENT_START_LOCK_STALE_MS` (30 s) on every cancellation that promotes a queued
  run (#174).
- RELEASE-GATE: the board and the release's component images deploy together,
  enforced by the deploy script itself. `deploy.sh` resolves the dockergate and
  fleetd digests of the SAME release (the `myr-vX.Y.Z` tag from the board image
  version label, else the `sha-<short>` tag of its commit) and refuses a release
  whose components are missing from the registry before anything changes — the
  01.10 incident deployed the board alone while production dockergate still
  rejected the new `maxConcurrentRuns` marker key and every bot apply was denied
  for ~40 minutes. Each component now rolls out in the same run with its own
  health probe (`MYR_<COMPONENT>_HEALTH_URL`), and a post-deploy smoke
  (`bot-apply-smoke.sh`) waits for at least one bot container to re-apply, else
  the deploy reports DEGRADED with the rollback commands
  (`rollback-component.sh` per component). CI gained the applied-marker contract:
  the markers `serializeAppliedMarker()` writes are emitted from the server code
  of every commit and fed through the dockergate validator, so a marker the
  validator would deny turns CI red before any image exists (#276).
- AUTO-RESUME: the board itself resumes an agent left in `error` by a failed
  run — a sweep on the scheduler tick with a backoff of 1, 5 and 15 minutes,
  reusing the pause/resume wake chain so the resumed agent also wakes the work
  it was stranded on. After `MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS` (default 3)
  failed resumes the board stops and escalates the agent's `agent_error_alert`
  card on the attention desk to severity `critical`; the operator's resume
  re-arms the counter. State lives in `agents.metadata.myrmidon_auto_resume`
  (no migration), every action writes an activity log row
  (`agent.auto_resume_issued` / `agent.auto_resume_exhausted`). Settings:
  `MYRMIDON_AUTO_RESUME_*` in [SETTINGS.md](SETTINGS.md); guide:
  [guides/auto-resume.md](guides/auto-resume.md) (#272).

### Telegram

- Telegram DM run status and inline split (U1). In a bridged Telegram DM
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) a run can now show its "working on
  it" status as one editable message instead of milestone silence: the status
  is posted once when the run is queued, the same provider message is edited
  in place as the phase changes, and the run's final answer replaces it —
  the failure, admin-attention and completion milestones still publish, and
  the `/stop` terminal milestone stays suppressed. Separately, a long
  structured Markdown answer that the vendor sends as one `.md` attachment
  can split inline into ordered parts at paragraph/line/word boundaries.
  Both behaviors are opt-in and off by default:
  `MYRMIDON_TELEGRAM_DM_STATUS` and `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS` (a
  document needing more parts than the cap stays an attachment); see
  [SETTINGS.md](SETTINGS.md) and the guide
  [guides/telegram-dm-status.md](guides/telegram-dm-status.md) (#267, #313).

## 1.3.2

Everything merged between the 1.3.1 and 1.3.2 tags. Deploy this release's dockergate image
together with the board.

### Bot containers

- The reconciler no longer recreates bot containers whose template never changed. dockergate
  trimmed `HostConfig.Binds` out of the container inspect (A2) while the driver's template-drift
  check compared it, so every bot counted as drifted on every pass: production recreated all 51
  bots every 17–20 minutes, interrupting every run in flight. The A2 answer carries the bind list
  again, and a gate contract test checks that every field the drift check compares survives the
  trim (the field list is emitted from the driver's code, not hand-copied) (#253).
- Every drift writes an activity line naming the field and both values
  (`bot container template drift detected`, `details.fields`), so it is diagnosable from the log
  alone instead of costing another incident (#253).
- The state-DB descriptor probe on the gateway write path is bounded: the WAL/SHM generation
  check now has a budget, so a slow or stuck filesystem no longer stalls every bot write (#240).
- Bot image development variant: a third build target with a repository-cycle toolchain is
  available for development work (#238).

### Interface

- Live browser screen console core: the owner watches and drives the live browser that bots
  authorize in. Registry, screen sessions with safe timers, a two-contour bot pause, the
  session journal and site-data cleanup. See [guides/browsers.md](guides/browsers.md) (#210).
- Access hub server core: the server module for the Access section (secrets, grants, rotation,
  SSH keys) is merged. See [guides/access-hub.md](guides/access-hub.md) (#235).
- Stack registry guide: the seeded component list, `GET /api/myrmidon/stack` and
  `POST /api/myrmidon/stack/refresh`, the cache and the Docker socket setting. See
  [guides/stack-registry.md](guides/stack-registry.md) (#243).
- Access-hub guide aligned with the merged server module (#249).

### Cloud storage

- Owner-authorized cloud storage with per-agent folder grants: the owner connects one account
  per provider, keeps a list of reachable folders and grants them to an agent, a caste or
  everyone with a read-only or read-write mode. OneDrive provider and API under
  `/api/myrmidon/cloud-connector`. See [guides/cloud-files-connector.md](guides/cloud-files-connector.md)
  (#245).

## 1.3.1

Everything merged between the 1.3.0 and 1.3.1 tags. The release replaces 1.3.0 and ships
the two fixes 1.3.0 lacks.

### Bot containers

- dockergate accepts the applied-profile marker with the optional `maxConcurrentRuns` key
  (integer 1–50) that the board writes since CONCURRENCY-SYNC. The 1.3.0 dockergate
  demanded exactly three keys and refused every bot-container profile apply with
  `tar_content` (`applied_json`), which stops the whole fleet on a fresh install. Deploy
  this release's dockergate image together with the board; a hand-swapped dockergate image
  is no longer needed. See [dockergate.md](dockergate.md#the-applied-profile-marker) (#228).
- Canary rollout for the bot image: a new bot image is applied to a single canary bot
  first, its health (Docker HEALTHCHECK plus a settle window) and a smoke run against the
  canary gateway are verified, and only then do waves of `MYRMIDON_BOT_CANARY_WAVE_SIZE`
  (default 4) bots follow, one bot at a time. A failed canary stops the rollout without
  touching the rest of the fleet; a rollout can be aborted. Routes:
  `GET/POST /api/myrmidon/bot-canary[/preview|/:id/abort]` (reads: board; writes: instance
  admin). Everything is off by default (`MYRMIDON_BOT_CANARY`). Design:
  [design/bot-canary.md](design/bot-canary.md) (in Russian) (#222).
- Bot settings resolve per fleet host: a `MYRMIDON_FLEET_HOSTS` record can override the
  hindsight URL, the LLM gateway base URL, the board's extra host name, the volume root,
  the bot network and the image allowlist for the bots placed on that host; a field absent
  from the record takes the instance value. See [SETTINGS.md](SETTINGS.md) (#225).
- New guide: [guides/bot-container-card.md](guides/bot-container-card.md) — the agent
  card's Container section, the concurrent runs limit and the applied-profile marker
  (#219).
- The card read is reconciled at pass time, not at the sweep's snapshot (#237).

### Database

- The chat and recovery hot sweeps compare uuid columns as uuid-typed, guarded values
  instead of text. A text-cast column cannot use its primary-key index, so every sweep
  scanned the whole table; on production that drove the board database to 300–400 % CPU.
  No new indexes are needed — the comparisons are served by the primary-key indexes (#227).
- Migration `0286` drops the ad-hoc operator expression indexes
  `myr_hotfix_issue_comments_id_text`, `myr_hotfix_wakeup_id_text` and
  `myr_hotfix_heartbeat_runs_id_text`, created outside the migration history to stop the
  bleeding. They are no longer needed once the predicates are typed (#227).

### Interface

- "About Myrmidon" section in Instance → General (release version, commit, build date,
  image digest when set, the Paperclip base version, license and links) and a release
  version line in the sidebar footer. The data comes from the new route
  `GET /api/myrmidon/about` (board/agent; anonymous gets 403) (#216).
- Fleet server console: a company owner opens a terminal to a registered fleet server in
  the browser (Guacamole with a signed auth JSON). New routes
  `GET/PUT /api/myrmidon/fleet/servers`, `POST /api/myrmidon/fleet/console-token`,
  `POST /api/myrmidon/fleet/console-sessions/close`; the servers live in the new table
  `myrmidon_fleet_servers` (migration `0287`). The section is on the company settings
  page. Design: [design/server-console.md](design/server-console.md) (in Russian) (#232).
- Per-agent LLM gateway keys (`POST /api/myrmidon/companies/<companyId>/litellm/keys/<agentId>`,
  `…/rotate`; `GET` returns only the secret name and the value's sha256; issue/rotate is
  board-only) and a cycle check of the fallback model chains when an agent card is saved
  (#233).

### Reliability

- An undelivered agent-to-agent card no longer dies from the task status flip: the card is
  delivered once before the terminal transition finalizes it (#234).
- Stack registry core: `GET /api/myrmidon/stack` serves the seeded component list with its
  local state (version/commit/digest or an honest "unknown"), and
  `POST /api/myrmidon/stack/refresh` (instance admin only) rebuilds the cache from what
  the board process can see; a failed infrastructure probe keeps the previous cache and
  answers 503. See [guides/stack-registry.md](guides/stack-registry.md) (#212).
- Guides: the access-hub guide gained the availability notice (#214).

## 1.3.0

The 1.3 feature release: bot containers on fleet hosts, the deploy of the board from the
interface, maintenance windows, the operator guides set and the groundwork listed in
[ROADMAP.md](ROADMAP.md). The full entry list is in the git history between the 1.2.1 and
1.3.0 tags. Two defects shipped in this release are fixed by 1.3.1: the dockergate marker
refusal (#228) and the database hot-path scans (#227).

## 1.2.1

Everything merged between the 1.2.0 and 1.2.1 tags.

### Memory and isolation

- Local fork of the hindsight memory plugin (`packages/plugins/hindsight-paperclip`, same plugin
  id `paperclip-plugin-hindsight`, version `0.3.0-myrmidon.1`): each agent's memory resolves to
  its own bank from the card's `adapterConfig.hindsight.bankId` or the configuration's
  `bankByAgentId` map. An agent without a bank is closed: retain is skipped with a warning and
  recall returns nothing — there is no fallback bank. Retain metadata now carries the agent
  name. Install and upgrade from the repository path; CI gained the fork's test lane and
  host-side install checks (#150).

### Bot containers

- Bot Node.js image: `/scratch/npm-global/bin` is off `PATH` — a writable volume on `PATH` let
  a bot plant a binary, and the dockergate image contract rejects it. The preinstalled packages
  in `/opt/node-tools` are unaffected; the Dockerfile test now checks every stage's `PATH`
  against the dockergate policy (#167).

### Interface

- Myrmidon favicon everywhere: worktree-preview instances draw the Myrmidon ant instead of the
  vendor paperclip, and tab icons and the web manifest are served with no-cache so browsers
  revalidate them (#166).

### Internal

- The agent-assigned MCP tool set moved from `heartbeat.ts` into its own module
  (`agent-assigned-tools.ts`) with no behaviour change, so heartbeat and the bot-container
  profile compiler resolve the same assignment from one place (#120).

## 1.2.0

Everything merged after the 1.1.0 tag, including fixes that were never tagged on their own.

### Bot containers

- Per-bot board tool gateway: container bots reach the board through their own scoped gateway.
- Shared media tools MCP service for container bots, with fixes for filter-escape injection,
  job-directory quota counting, streamed conversions and spool ownership.
- `dockergate`: an allowlisting Docker proxy for bot containers.
- Bot image: Node.js variant (`runtime-node`), an ssh client, and a venv interpreter present
  for the bot user.
- Bot board API keys are issued with a responsible user.
- Configurable run-create timeout for the hermes gateway (default 60 s).
- Container startup feedback in the server tests no longer needs a real container.

### Memory and isolation

- Hindsight bank allowlist and observation scopes in bot profiles, plus a tool to split
  banks when transferring memory.
- Plugin `apiRoute` calls are bound to an invocation scope.

### Wakes and heartbeat

- Emergency stop for the runs a draining pause left finishing: the agent detail page shows a
  banner with a confirm-and-stop button while the agent is paused and live runs remain, and
  `POST /api/myrmidon/agents/:id/emergency-stop` cancels them immediately with the same
  `agent_paused` code a pause-cancel uses — the agent's own status is untouched (#173). Operator
  guide: [guides/emergency-stop.md](guides/emergency-stop.md).
- Continuation wakes: age-threshold sweep and direct-delivery settlement fixed.
- Tasks stranded by an operator pause are woken in batches when the pause is lifted.
- Configurable cap on cross-issue influence.
- Heartbeat logs an unreadable cgroup memory limit; the cap is documented.
- Kill-switch flag semantics are covered by a test matrix and a docs guard; documented that the
  L2 budget carry is L1-only and that the vendor retry budget restarts at the successor.

### Deploy

- Deploy lifts maintenance mode when the drain times out.
- Documented that database migrations must be additive-only.

### Process

- Plan intake procedure and text scanner for plan entries.
- Publish scan wrapper for PR and issue text.
