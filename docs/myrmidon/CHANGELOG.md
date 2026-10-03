# Myrmidon changelog

> Russian version: [CHANGELOG.ru.md](CHANGELOG.ru.md)

Release notes for Myrmidon, newest first. The version comes from the git tag
`myr-v<major>.<minor>.<patch>` (CI stamps it into the image and `/api/health`); there is no
version file to edit. Base Paperclip version is in the image label
`io.github.itkadr-git.myrmidon.base.paperclip-version`. Details of the release procedure:
[ci.md](ci.md) and [deploy.md](deploy.md).

## 1.6.1

### Gateway-priced hermes runs (HERMES-USAGE-COST)

- hermes_gateway runs no longer land in the cost ledger as unpriced $0
  rows: after every LLM-gateway spend collection sweep, a reconcile pass
  fills each run's `cost_events` row with the gateway's own spend for that
  run (cost_status=reported) and refreshes the agent/company monthly
  counters. Only unpriced hermes_gateway rows are touched — adapter-priced
  rows and other providers are never overwritten, and a run with no
  collected spend stays unpriced instead of getting an invented price. The
  first sweep can look back up to 90 days
  (`MYRMIDON_LITELLM_FIRST_LOOKBACK_DAYS`), and
  `POST /api/myrmidon/companies/:id/litellm/sweep` accepts a `from` body
  for one-off month backfills. The UI-2.0 forecast chip shows
  "spent" only when no monthly budget is configured, ending the
  "$0 of $0" placeholder.

### Board administrators from agents (ADMIN-AGENT part C)

- The UI half of making an agent a board administrator. The agent card's
  **Permissions / Trust** tab gains a fourth flag, **Board administrator**:
  flipping it goes through the same permissions PATCH as the three sibling
  flags, the state comes from the agent detail API
  (`access.boardAdmin`, falling back to `permissions.boardAdmin`), and both
  readers are fail-closed — anything but an explicit `true` reads as "not an
  administrator". Operators see the toggle only with permission-management
  authority (owner or admin membership, instance admin, local implicit
  board); a 403 from the API becomes a plain-language note under the toggle.
  The Company Settings **Members** page names every agent administrator: one
  table row per non-terminated flagged agent, with a **Board administrator**
  badge and a link to the agent's Permissions tab. The grant semantics (the
  permission keys, the grant snapshot, the self-toggle prohibition) are the
  server half of the feature and merge separately. Operator guide:
  [guides/agent-board-admin.md](guides/agent-board-admin.md).

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
  screen (part A) is below.

### CTO chat (CTO-CHAT)

- The Commander chat screen of the 2.0 shell (route `commander-chat`, reached
  from the rail, the phone bottom bar and the `Ctrl K` "Tell the Commander"
  palette with the typed draft carried over): the owner writes one free-text
  request, the screen calls the board chat planner
  (`POST /api/myrmidon/companies/:companyId/cto-chat/plan`) and renders the
  proposed epic read-only — the epic, every child task, acceptance criteria
  line by line. The pending `suggest_tasks` approval card from the standing
  Agent Chat issue renders through the existing card component; accepting
  the card creates the issues, rejecting creates nothing. The same flow is
  reachable from the owner's Telegram DM. Operator guide:
  [guides/commander-chat.md](guides/commander-chat.md).

### Reference-task evals (EVALS-A part A)

- The evals path: a seeded corpus of neutral reference tasks for the pilot
  role `engineer`, an LLM judge behind the company's LLM gateway (a free
  DashScope model by default, one chat-completions call per task, strict JSON
  parsing — an unparseable response scores zero with a `parseError` flag, not
  invented points), per-task rubric scoring with the CI pass rate folded in
  for `code` tasks, and a promote/confirm/regress verdict where a drop beyond
  the threshold is only actionable after a confirmation run repeats it. The
  judge never executes code. Scores live in `myrmidon_eval_runs`; the optional
  Langfuse export is off by default and never blocks local scoring. Reads are
  company-scoped, run mutations need a board actor, and an unconfigured
  contour answers `503` with the names of the missing settings. The verdict
  seam for the skill lifecycle (`candidate → verified → deprecated`, with
  rollback) is exposed as `POST …/evals/verdict`; the merged lifecycle module
  does not wire it to the board yet. Guide: [guides/reference-task-evals.md](guides/reference-task-evals.md).

### Stack update screen (STACK-UPDATES part C)

- The «Stack» screen in the panel (Company → Stack, route `/stack`): every
  component of the stack registry with our version/commit/digest (or an honest
  `unknown` with the reason), where it runs, the latest upstream release, the
  release lag, the notable security/breaking lines of the release notes as a
  collapsible excerpt and the patch-closed verdict per carried delta; lagging
  components sort first, with a name filter. *Refresh data* and *Check
  releases* run the instance-admin `POST /api/myrmidon/stack/refresh` /
  `POST /api/myrmidon/stack/check` from the screen — a failure, including the
  503 of a broken probe, is shown in place without losing the table. The
  *Schedule update* button on a lagging row opens a dialog with a default plan
  (versions, our patches, notable lines, canary then production, rollback) and
  creates an unassigned backlog draft task through the existing issue-creation
  route — nothing is deployed from the screen. The release check itself
  (part B: the schedule, the excerpt rules and the patch-closed verdict) and
  the registry API are documented in the same guide. Guide:
  [guides/stack-registry.md](guides/stack-registry.md).

### Stack update cycle documentation (STACK-UPDATES part D)

- The stack-updates overview document (EN + RU) for the whole release-watch
  cycle: where «ours» comes from per probe (health-commit, docker-image,
  container-labels, env, manual, none) and where «latest» comes from (the
  anonymous GitHub releases/tags read), how the lag is counted and why an
  unmatched local version reads `unknown`, the notable-lines excerpt rules,
  the patch-closed verdict (closed/open/unknown per carried delta through the
  compare API, with the aggregate), the daily sweep behind
  `MYRMIDON_STACK_CHECK_INTERVAL_SEC` and the manual check, the
  `stack_update` attention card with its dedup key, the unassigned backlog
  draft the planner creates, both settings and the network-down behavior
  (transport failure → 503 with the previous cache intact; a per-source HTTP
  error → a per-component unknown). The screen-by-column screen guide is
  referenced, not duplicated. Document: [stack-updates.md](stack-updates.md).

### Company regulations in the wiki (WIKI-CORTEX)

- Regulation pages with a draft → approved lifecycle, revisions and rollback:
  an edit of a draft or of an approved regulation appends a new DRAFT revision
  and the resolver keeps serving the newest APPROVED one, so writing text
  never changes what the fleet reads without an explicit board approval; a
  rollback is one more revision that copies an earlier one (append-only
  history, the restore is itself restorable). Draft writes are open to any
  actor with access to the company — the wiki maintainer agent writes drafts —
  while approve and rollback are board-only. The approved regulations that
  apply to a role reach the agents through the compiled bot profile: one
  deterministic workspace `REGULATIONS.md` beside the agent's own instruction
  files, where the profile hash decides whether a bot restarts (same approved
  revisions — same bytes — no restart; the file never shadows a
  `REGULATIONS.md` the agent's own bundle ships). Roles are plain role keys
  with `*` meaning every role. Operator guide — the API, the delivery
  mechanics and the wiki-maintainer runbook:
  [guides/wiki-regulations.md](guides/wiki-regulations.md).

### Autonomy matrix

- Role-by-action-class verdicts that say what an agent of a role may do on its
  own and what needs the board: the matrix is stored as company regulations
  with revisions and is served through a REST API. The «Autonomy matrix»
  settings screen shows and edits the matrix; every change is a new revision,
  so the previous verdicts stay readable and restorable.

### Swarm claims (SWARM-CLAIM)

- Part A, per-role task queues with leased claims: an agent takes the top task
  of its own role's queue behind a lease (TTL plus heartbeat) recorded in the
  new `issue_claims` table. The run's checkout writes the claim and a finishing
  run releases it; a sweep returns expired leases, and leases of tasks that
  left the queue, to the queue and wakes the next agent of the role. A
  per-agent active-task limit keeps one agent from taking the whole queue, and
  a P0 (critical) task preempts the normal queue order. The claim path is off
  until `MYRMIDON_SWARM_CLAIM_ENABLED` is turned on; the lease TTL, the active
  task ceiling and the sweep interval are `MYRMIDON_SWARM_LEASE_TTL_SEC`,
  `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` and
  `MYRMIDON_SWARM_CLAIM_SWEEP_INTERVAL_SEC`.
- Part B, the supervisor view and the pilot report over claims and leases: the
  queue and lease state per role, and a window comparison against the frozen
  baseline snapshot. The release fallback now also writes the release reason.
  The supervisor settings (`MYRMIDON_SWARM_SUPERVISOR_TASK_MAX`,
  `MYRMIDON_SWARM_PILOT_BASELINE_DOC`) are documented in
  [SETTINGS.md](SETTINGS.md).

### Skill lifecycle (SKILL-LIFECYCLE)

- The company skill lifecycle `candidate → verified → deprecated`, with
  approval-gated promotion and rollback. A `candidate` skill reaches only the
  agents listed in `MYRMIDON_SKILL_PILOT_AGENTS`; a `verified` skill reaches
  everyone. With the variable unset the pilot set is empty, so a candidate
  reaches nobody.

### Foraging (FORAGING)

- A source registry per company, snapshot comparison of the sources, skill
  candidates drafted from what changed, a per-pass cost budget and a screen.
  Foraging ships DISABLED: no timer is armed and no source is read unless
  `MYRMIDON_FORAGING_ENABLED=1` is set; any other value keeps it off, so a
  typo cannot turn it on.

### Baseline metrics (BASELINE part A)

- Six board metrics computed from the task history over any window, by
  project and by executor role: cycle time (todo → done, mean, median, p90),
  time in review, return rate (in review → in progress), time blocked with the
  top reasons, runs per task and LLM cost per task. They are served by
  `GET /api/myrmidon/companies/:companyId/baseline/metrics?from&to`. A periodic
  job, off unless `MYRMIDON_BASELINE_INTERVAL_SEC` is set, recomputes the last
  14 days per company and freezes one snapshot per pass in the additive
  `baseline_metric_snapshots` table, so a pilot can be compared with the
  measured «before». A failure of one company does not stop the others.

### Parallel helpers (PARALLEL-HELPERS)

- Agents can run parallel helper subagents. The agent card gets a «Parallel
  helpers» block: on/off, the maximum number of concurrent helpers within a
  company ceiling, and the helper model from the allow-list; a company default
  and a capacity hint sit beside it. The profile compiler writes the matching
  delegation section for bot containers. When neither the card nor the stored
  settings name a model, helpers run on `MYRMIDON_BOT_HELPER_MODEL`, or on the
  parent agent's model if that is unset.

### Quality and stack

- The Quality page: window metrics by project and by role, built on the
  baseline metrics above.
- The Stack screen's release lag, patch status and update planner (described
  in «Stack update screen» above) are documented in the stack guide, together
  with the LLM tracing card and the operator signal guide.

### Myrmidon 2.0 UI (behind `enableMyrmidonUi2`, off by default)

- The 2.0 shell and six re-skinned data screens, shown only when the
  `enableMyrmidonUi2` experimental flag is on; the denied lock fails closed
  and there is no client-side undo timer. A per-user board UI language (RU/EN)
  with catalogs and guards, an operator guide for the shell, and a fix of the
  i18n guard so that it accepts the flat re-skin catalog.

### Bot containers

- The run-bound GitHub broker capability is delivered to container runs of the
  gateway adapter; the token reaches only the agents listed in
  `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST`. Bot-side media scripts ship
  under `tools/media-mcp/bot-scripts`, with a hygiene pass over them.

### Deploy and release

- `rollback.sh --local` rolls back to a local image without pulling.
- The GitHub Release is now published by CI from the `myr-v*` tag, using this
  file's section for the tag's version.

### Fixes

- The Telegram DM status is one edited message with live progress steps
  instead of repeated «working…» messages.
- Maintenance: leaving windows always retire, the tick isolates windows from
  each other, and the owner chat never waits on it.
- Closing a channel-bound task by its assigned agent notifies the bound chat.
- No run is dispatched for a task whose delivering PRs all merged (the wake
  guard); its settings are `MYRMIDON_TASK_PR_SYNC_WAKE_GUARD_*`, and the
  settle sweep and the guard have an operator guide.
- The gateway adapter joins the idempotency-keyed adapters for infra-interrupt
  relief.
- Secrets are masked in comment edits, issue descriptions and documents.
- CI: five flaky tests were made deterministic, two real races behind them
  were fixed, and three tests that blocked unrelated PRs were deflaked.

### Upgrade notes

- Additive migrations 0289–0295 (among them 0294, the baseline metric
  snapshots, and 0295, the issue claims); no vendor table is modified.
- Every new setting is off or closed by default; see [SETTINGS.md](SETTINGS.md)
  before enabling any of them.

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
- The browser action primitives in the shipped extension (EXTCASE-D):
  `browser.fill` types a value into one field (input, textarea, select or a
  contenteditable node) and dispatches `input`/`change` so the page sees the
  change; `browser.download` fetches the file in the page's own session —
  the content script runs in the page's origin, so the request carries the
  browser's cookies — and returns its name, type, size and base64 bytes under
  a 25 MiB ceiling (`BROWSER_DOWNLOAD_MAX_BYTES`; a larger file is refused
  with `downloadTooLarge` before it crosses the bridge). An action the board
  marks `confirmation: "human"` runs only after a person on the client PC
  presses Confirm in the extension's confirm page: a refusal, the 180-second
  budget expiring — the gateway then sends the `browser.cancel` notification
  and the extension drops the pending step — or a build without the
  confirmation port is an `internalError` refusal (the step never reaches the
  confirmation flow), never a silent execution. The extension declares the `fill` and `download` capabilities and
  never `sign`. Site-specific selectors and recorded scenarios are built on
  top of these primitives and live outside the fork. Guide:
  [guides/bridge-extension.md](guides/bridge-extension.md).
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
  and the other locales (English values until the translation pass). Operator
  guide: [guides/ui2-shell.md](guides/ui2-shell.md).
- The six re-skinned screens behind the same flag (Decisions, Costs, Agent
  overview, Runs and queue, System, Language) now render real data through
  the existing APIs — no new server endpoints. Each screen ships the full
  state set (skeleton, error with/without cache, empty, denied): a `403`
  answer renders the lock alone, never partial data. Decisions decide with
  option, inputs and an idempotency key; there is no client-side undo timer
  (the server-side hold is a later wave). Screen-by-screen details:
  [guides/ui2-shell.md](guides/ui2-shell.md).

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

### Container GitHub access (CONTAINER-GITHUB-WRITE)

- An agent in a bot container can push to GitHub through the board's managed
  credentials (#363): when a run's GitHub identity is board-managed (the
  default, see `MYRMIDON_HOST_GITHUB_CREDENTIALS` in
  [SETTINGS.md](SETTINGS.md)), the heartbeat mints a run-bound
  `github_credentials` capability, and the `hermes_gateway` adapter now
  carries it to the container — the pair rides the `/v1/runs` request body
  (`github_broker`), is bound to that run alone (contextvars, never the
  process env shared by the gateway's concurrent runs) and reaches every
  terminal and `execute_code` subprocess of the run as
  `PAPERCLIP_GITHUB_BROKER_URL`/`PAPERCLIP_GITHUB_BROKER_TOKEN`. Inside the
  container, the dev image's `git` credential helper (URL-scoped to
  `github.com` over https, `ssh://git@github.com/…` remotes rewritten to
  https) and its `gh` wrapper resolve the credential on each invocation
  through the board's `POST /runtime-tools/github/credentials` broker and
  exec the real `git`/`gh`; the wrappers walk up to 6 broker address
  candidates (`PAPERCLIP_GITHUB_BROKER_URL` → `PAPERCLIP_API_URL` →
  `PAPERCLIP_RUNTIME_API_URL` → `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON`
  items) and never print the token. A run without a capability — or a card
  whose GitHub identity is not board-managed — gets both names stripped and
  the wrappers fail open, exactly as before this change. A static
  `GH_TOKEN`/`GITHUB_TOKEN` inherited from the image profile no longer
  shadows the credential: while a capability is bound, those names are
  blanked in the run's subprocesses. This closes the gap that motivated
  `MYRMIDON_BOT_CONTAINER_GITHUB_ENV_ALLOWLIST` (see SETTINGS.md): the
  allowlist remains a fallback for dev bots on machines where the board's
  broker address is genuinely unreachable.

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
