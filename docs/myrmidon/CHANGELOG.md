# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

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

### Owner questions and instructions

- U2: question and confirmation cards (`ask_user_questions`, `request_confirmation`)
  reach the owner's Telegram DM when the company runs the Telegram DM bridge
  (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) — the card is also answered from Telegram,
  including a callback that arrives for a task the authoring agent no longer owns.
  A task with its own live chat binding keeps its card in that conversation only.
  Guide: [guides/owner-telegram-cards.md](guides/owner-telegram-cards.md) (#277, #284, #287).
- H2: every change to an agent's instructions bundle (file put, file delete, patch)
  is snapshotted into the append-only `agent_instructions_revisions` history, and any
  earlier revision can be restored through the API — the restore itself becomes a new
  revision. Guide: [guides/agent-instructions-revisions.md](guides/agent-instructions-revisions.md) (#273, #299).
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
