# Deploying and rolling back Myrmidon

> Russian version: [deploy.ru.md](deploy.ru.md)

Deploys pin the image digest of `ghcr.io/itkadr-git/myrmidon`, not a tag: a tag can be moved,
a digest cannot. Only an image built by CI reaches production (the owner's decision): the
deploy script enforces it before anything else, see [CI-built images only](#ci-built-images-only).
The scripts live in [`scripts/myrmidon/deploy/`](../../scripts/myrmidon/deploy/)
and know nothing about a specific installation: everything comes from the settings file. An
example is [`deploy.env.example`](../../scripts/myrmidon/deploy/deploy.env.example); the real
settings file of an installation lives in a private deploy repository and never enters this one.

## What the host needs

- bash 4+, `docker` with the `compose` and `buildx` plugins, `curl`, `jq`, `git`;
- the scripts run from a clone of `itkadr-git/myrmidon` whose `origin` points at
  `github.com/itkadr-git/myrmidon`: the clone is how the image commit is checked against
  `main` (see below). From a directory without git, or from a clone of another repository,
  the deploy refuses;
- the Myrmidon server runs under docker compose, and the service image is set in a separate
  override file (`COMPOSE_OVERRIDE_FILE`). The script changes only the `image:` line in it;
- a database dump command (`DUMP_COMMAND`) and, for a rollback with a restore, a restore
  command (`RESTORE_COMMAND`). Both get the path in the `DUMP_FILE` variable;
- in `authenticated` mode, anonymous `/api/health` shows the commit but not the version. A
  board key in a file with mode `0600` at `HEALTH_TOKEN_FILE` is **required**: without it the
  version check at step 7 fails and the deploy counts as failed (by design — the version is
  always checked);
- how to count runs in progress: `RUNNING_RUNS_COMMAND` or `MAINTENANCE_MODE=api`. If the
  counter fails (an error or empty output), the deploy stops before the image changes. The
  wait can be skipped only explicitly: `ALLOW_UNKNOWN_RUNS=1`.

## Where to get the digest

In the summary of the `image` job of the **Myrmidon image** workflow (Actions → the run on the
commit or tag): the `Digest` line. Or:

```sh
docker buildx imagetools inspect ghcr.io/itkadr-git/myrmidon:1.0.0 --format '{{json .Manifest.Digest}}'
```

`--digest` accepts `sha256:<64 hex>` or the full reference
`ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>`. The script does not take a tag (`1.0.0`, `main`,
`ghcr.io/itkadr-git/myrmidon:1.0.0`): a tag cannot prove the image is the one that passed CI.

The version and commit that `/api/health` must report come from the image labels
(`org.opencontainers.image.version`, `org.opencontainers.image.revision`). They can be set
explicitly: `--expect-version`, `--expect-commit`.

## CI-built images only

The owner's decision: only an image built by CI (the **Myrmidon image** workflow) from `main`
or from a `myr-v*` tag reaches production. A hotfix also goes through a PR, even an expedited
one, not through an image built on the spot. A hand-built image reaches production bypassing
the repository and review, and on the next deploy its content silently disappears: it is not
in the repository.

`deploy.sh` enforces this **before any action** (before `docker pull`, the dump and
maintenance) and on any "no" exits with the reason, changing nothing:

1. **The reference** is exactly `ghcr.io/itkadr-git/myrmidon@sha256:<64 hex>`: no tag without
   a digest, no other repository or registry, no uppercase in the digest. `MYRMIDON_IMAGE` in
   the settings file must equal `ghcr.io/itkadr-git/myrmidon`; any other value is a refusal.
2. **The image is in the registry.** Its manifest and config are read from the registry
   (`docker buildx imagetools inspect`) without pulling the layers. A locally built image is
   not there; an unreachable registry is a refusal too.
3. **CI labels.** The image carries `org.opencontainers.image.revision` (the full commit sha)
   and `org.opencontainers.image.source` equal to `https://github.com/itkadr-git/myrmidon`.
   CI sets these labels at build time.
4. **The commit is checked.** The script runs `git fetch origin main` in the clone that holds
   it and requires the label commit to be reachable from `origin/main`, or to carry a
   `myr-v<x>.<y>.<z>` tag in `origin` (`git ls-remote --tags`). An image built from a branch
   or from unreviewed code does not pass. No git, the script outside a clone, a foreign
   `origin`, a failed fetch — a refusal with a clear reason.

There is no bypass: no flag, no setting. `--force` (redeploying the same image) and
`--expect-*` do not skip the check. To deploy an image that does not pass, the image must go
through CI: a PR into `main`, a merge, a build.

### Deploy the board and the release components together

Since 1.4.0 (RELEASE-GATE, after the 01.10 incident) `deploy.sh` deploys the release's
component images (dockergate, fleetd) **in the same run** as the board image, and refuses
a release whose components are missing from the registry **before anything changes**. The
digests are resolved from the same release: the `myr-vX.Y.Z` tag from the board image
version label, else the `sha-<short>` tag of its commit
(`scripts/myrmidon/dockergate/check-release-support.sh`). There is nothing to look up by
hand: the operator passes the board digest and the script finds the matching component
digests itself.

The components are listed in `MYRMIDON_RELEASE_COMPONENTS` (default `dockergate,fleetd`).
Each component rolls with its own pull by digest, its own override file
(`docker-compose.myrmidon-<component>.yml`), a service recreate and a **required** health
probe (`MYR_<COMPONENT>_HEALTH_URL`; unset means the component rollout refuses after the
switch — fail-closed). A failed component rollout or a failed post-deploy smoke ends the
deploy as DEGRADED with the rollback commands printed; the board itself is already healthy
at that point, so the rollback is the operator's decision. `MYRMIDON_RELEASE_COMPONENTS=none`
restores the board-only behavior (not for a release: the 01.10 incident was exactly that
split). The settings are in [SETTINGS.md](SETTINGS.md); an example is in
[`deploy.env.example`](../../scripts/myrmidon/deploy/deploy.env.example).

A component does not have to run on the deploy host (`MYR_<COMPONENT>_HOST`, the 02.10
follow-ups): `local` (the default) rolls it in this host's compose project — the rollout proves
the service is part of that project first (`docker compose config --services`) and refuses BEFORE
pulling or writing anything when it is not (fail-closed); `remote:<user>@<host>`
rolls it on another host — docker and compose run through ssh (key auth, no password prompt),
the override file is written there under the same relative path, and the health URL is probed
from the deploy host, so give the address the deploy host reaches, not a remote localhost;
`skip` declares the component not managed by this deploy (its own procedure rolls it out
elsewhere) — the rollout then prints a loud SKIP and still verifies the digest passes the
CI-image gate. The 1.4.0 production install hit exactly this: fleetd lives on the second host,
the rollout created `paperclip-fleetd-1` on the board host, it exited at once (no
`/etc/myrmidon-fleetd/config.json` there) and the operator removed it by hand — point
`MYR_FLEETD_HOST` at the host fleetd actually runs on.

When your installation runs a component from a compose file of its own (dockergate of the
1.4.0 production install runs from `myrmidon/compose.yml`, not from a
`docker-compose.myrmidon-dockergate.yml` override), set `MYR_<COMPONENT>_COMPOSE_SERVICE`
and `MYR_<COMPONENT>_OVERRIDE_FILE` so the rollout's service recreate targets the service
that actually runs, and the override file it writes is the one your compose stack reads:
one service, one image line, one source of the image. The override the rollout writes
contains only the image line, so a service defined in your own compose file keeps its
volumes, sockets and networks; the override only pins which image it runs.

### Bot images roll out with the board (BOT-IMAGE-ROLLOUT)

Since 1.6.1, a deploy also rolls the **bot runtime images** of the same release —
`myrmidon-hermes`, `myrmidon-hermes-dev`, `myrmidon-hermes-node` — with no manual steps.
The 03.10 incident: the board became 1.6.0 while the dev bots stayed on the old
`hermes-dev` image; the new image was not even in dockergate's `images` allowlist and the
operator moved the bots by hand. `deploy.sh` now calls
[`bot-image-rollout.sh`](../../scripts/myrmidon/deploy/bot-image-rollout.sh) (step 9.5,
after the components, before the smoke — the smoke then proves a bot actually re-applied
on the new image), and the script can run standalone after any missed rollout:

```sh
scripts/myrmidon/deploy/bot-image-rollout.sh --config deploy.env \
  --resolution tag --ref myr-v1.6.1     # or: --resolution sha --ref 0123456
```

What it does, fail-closed (nothing changes until the checks pass):

1. **Resolve.** The three bot image digests resolve from the same release as the board
   (the bot image workflow tags `sha-<short>` and `myr-vX.Y.Z` like every component, via
   `check-release-support.sh`). A release whose bot images are missing is refused before
   anything changes — a board the bots cannot follow is exactly the 03.10 split.
2. **Pull.** Every resolved image is pulled on the local host and on each
   `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS` host (the container drivers never pull).
3. **Allow.** The new digests are added to dockergate's `images` (a structural jq edit of
   `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG`, verified by `dockergate check-config`
   when `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND` is set), then dockergate
   re-reads the config (`MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND`, SIGHUP).
   The **old** bot images stay allowed until the last bot moved, so a mid-rollout failure
   never strands the un-moved bots.
4. **Enroll.** Every `hermes_gateway` agent with an enabled container block is enrolled in
   dockergate's `bots[]` (limits from the card: `container.memoryMb/cpus/pidsLimit`). A bot
   missing from `bots[]` is exactly the `bot_not_enrolled` refusal that hit Wiki Maintainer
   on 03.10; after this, a new bot on the board starts with no config edit by hand. Fleet
   hosts get the same enrollment in their fleetd config
   (`MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_CONFIG`).
5. **Switch.** The bot cards switch to the release image **one bot at a time** (the
   `MYRMIDON_BOT_IMAGE_ROLLOUT_CANARY` agent first when set): PATCH
   `/api/agents/:id` with only `adapterConfig.container.image`, then POST
   `/api/myrmidon/agents/:id/bot-container/apply` so the board's own reconciler drains that
   agent alone and recreates the container. A bot with a running run answers `deferred`:
   the rollout retries it for up to `MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC` seconds,
   and **a run is never interrupted by the rollout** — a deferred bot keeps its old card
   image until a later retry or the periodic sweep.
6. **Retire.** After every bot runs a release image, the superseded bot image refs (only
   refs of our three bot repositories, never a pinned third-party one) are removed from
   `images` and dockergate re-reads the config again. Deferred bots keep the old refs
   listed until they move.
7. **Journal.** Every switch is appended to `STATE_DIR/bot-image-rollout.log`
   (`UTC agent-id old-image -> new-image (outcome)`) and to the deploy history, and the
   deploy log lists every bot with its image.

`MYRMIDON_BOT_IMAGE_ROLLOUT=0` restores the manual path (the deploy warns — that is the
03.10 split by choice). All settings are in [SETTINGS.md](SETTINGS.md) with examples in
[`deploy.env.example`](../../scripts/myrmidon/deploy/deploy.env.example). A failed bot
rollout ends the deploy DEGRADED with the rollback commands, never silently.

This rollout is also the foundation for the in-UI auto-update of OPE-3967 (1.7): the UI
job will call the same resolution, allowlist, enrollment and card-switch steps.

### Upgrading from 1.4.0 to 1.5.0

The 1.5.0 additions are additive on the host side: no new migrations to run by
hand and no changes to the deploy script — the upgrade is the image switch of
the release components, as in the 1.4.0 procedure above.

What changes for operators:

- **Set the bridge pepper before the first connector pairing.**
  `MYRMIDON_BROWSER_BRIDGE_PEPPER` is the HMAC pepper for pairing codes and
  bridge tokens; unset, the process takes a random pepper per start (one log
  warning) and every paired device must pair again after each restart. Set it
  once in the board's environment before issuing the first pairing code. See
  [SETTINGS.md](SETTINGS.md) and
  [guides/browser-bridge-gateway.md](guides/browser-bridge-gateway.md).
- **The connector panel appears in Company settings → Connectors.** The bridge
  state lives in `instance_settings.general.browserBridge` (domains, signing
  policy); existing instances start with an empty allowlist and the default
  signing policy (`enabled`, mode `auto`, no daily limit) — nothing pairs and
  nothing is signed until an operator configures it. Panel writes need the
  instance admin role. See
  [guides/connector-panel.md](guides/connector-panel.md).
- **The OCR path stays closed until configured.** Without
  `MYRMIDON_OCR_BASE_URL` and `MYRMIDON_OCR_KEY_SECRET` the `ocr.pdf` tool
  answers a stable `ocr_disabled` refusal and no request leaves the board; bots
  that never call it are unaffected. To open the path, set the contour address,
  the secret name and (for LiteLLM) the model — see [SETTINGS.md](SETTINGS.md)
  and [guides/ocr.md](guides/ocr.md).
- **External MCP connectors need no fork change.** An instance that already
  runs `PAPERCLIP_DEPLOYMENT_MODE=authenticated` with
  `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` accepts private-network connector
  containers; do not flip exposure to `public` while one is connected. The
  connect/grant runbook is
  [guides/external-mcp-connectors.md](guides/external-mcp-connectors.md).

### Upgrading from 1.3.2 to 1.4.0

Deploy the board, dockergate and fleetd images from the same 1.4.0 tag together — with
1.4.0 the script does this in one run (the section above): pass the board digest, and the
dockergate and fleetd digests of the same tag are resolved and rolled automatically. No new
migrations to run by hand: the upgrade is image-only on the host side. For the component
health probes to pass, set `MYR_DOCKERGATE_HEALTH_URL` and `MYR_FLEETD_HEALTH_URL` in
`deploy.env` before the deploy (see [SETTINGS.md](SETTINGS.md)).

What changes for operators:

- **Automatic rollback by health is on by default** (R5-C). A failed post-deploy health
  check no longer leaves the board on the broken image: the host executor immediately
  runs `rollback.sh` to the image the deploy remembered before the switch, and the job
  closes `auto_rolled_back` with the maintenance window lifted. A failed rollback itself
  ends `failed_rollback` with the window kept on for the operator. To restore the 1.3.x
  manual contract, set `AUTO_ROLLBACK=0` in `deploy.env` AND `MYRMIDON_DEPLOY_AUTO_ROLLBACK=0`
  on the board side — both sides must agree. See [SETTINGS.md](SETTINGS.md).
- **The bot fleet got the same protection**: a failed canary or wave bot moves the rollout
  to `rolling_back`, every touched bot is returned to its own card image one at a time, and
  the rollout ends `rolled_back` with the original failure reason kept. Disable with
  `MYRMIDON_BOT_CANARY_AUTO_ROLLBACK=0` to keep the canary on the new image for inspection.
- **Unattended auto-update stays off**: `MYRMIDON_DEPLOY_AUTO_UPDATE` defaults to `0` —
  every deploy still waits for an explicit human confirmation in the interface. Enable it
  only after the release scenario has run on the staging stand.
- **New optional section on the agent card**: the Memory tab (view, export, removal of the
  agent's memory bank) is off until the instance sets `MYRMIDON_HINDSIGHT_API_URL` and
  `MYRMIDON_HINDSIGHT_KEY_SECRET`. Without the pair nothing changes on the card.
- **Cloud storage (part B)**: the owner can now connect a cloud provider from the panel
  with OAuth; the token bundle lives in a company secret of the instance secret store and
  never reaches the bots. No action needed at upgrade time — existing grants keep working.

`--dry-run` runs the same check (it only reads the registry and updates `origin/main` in the
clone), so a trial run shows the refusal in advance.

Scope. This protects against mistakes, not against malice: someone with write access to the
`ghcr.io/itkadr-git/myrmidon` package can push an image with foreign labels. So write access
to the package must belong only to the build workflow (a GitHub package setting; the script
does not check it).

## Deploy

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<64 hex> --dry-run
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<64 hex>
```

Order:

0. The image check (the section above). If it fails, the deploy does not start and nothing is
   touched. Right after it the component digests of the same release are resolved
   (`check-release-support.sh`); a release whose components are missing from the registry is
   refused here too, before the pull and the dump.
1. `docker pull` of the image by digest. If it does not pull, the deploy does not start.
2. The current image from the override file is remembered as the previous one: the full
   reference goes to `$STATE_DIR/previous-image` (so the first switch from a vendor image
   works too), the fork digest also to `$STATE_DIR/previous-digest`.
3. A database dump by `DUMP_COMMAND` into `DUMP_DIR`. If the file is missing or smaller than
   `DUMP_MIN_BYTES`, the deploy refuses and the image does not change.
4. Entering maintenance mode (`MAINTENANCE_MODE`):
   - `api` — `POST /api/myrmidon/maintenance` per the contract of
     [design/maintenance-mode.md](design/maintenance-mode.md), section 7 (track 5, R3).
     The window is entered with `onTimeout: interrupt_and_retry` and
     `drainTimeoutSec: MAINTENANCE_DRAIN_GRACE_SEC` (300 s by default), so a planned
     deploy does not wait for long runs. `MAINTENANCE_ON_TIMEOUT=wait` keeps the old
     behaviour: the window is entered with `onTimeout: wait` and
     `drainTimeoutSec: MAINTENANCE_DRAIN_TIMEOUT_SEC` (1800 s) instead;
   - `hook` — your own `MAINTENANCE_ENTER_COMMAND` / `MAINTENANCE_EXIT_COMMAND`;
   - `pause` — while there is no maintenance API: pause for `MAINTENANCE_PAUSE_SEC` seconds.
5. Waiting until no runs are in progress: `RUNNING_RUNS_COMMAND` or, in `api` mode,
   `instance.runningRuns` from the API. With the default `onTimeout: interrupt_and_retry`
   the window drains for the grace (`MAINTENANCE_DRAIN_GRACE_SEC`, 300 s) and then
   interrupts the runs that are still going: each one is marked interrupted by maintenance
   (not a failure), its task keeps its place, and the run is retried automatically when the
   window closes. That is what makes the wait converge quickly instead of blocking on a long
   run. A `RUNS_WAIT_TIMEOUT_SEC` timeout (or a broken
   counter) aborts the deploy before the image changes, and **maintenance is lifted before
   the abort exit**: the board does not stay in maintenance until someone lifts it by hand.
   A failed lift (maintenance already off) is a warning, not a second failure; the exit
   reason stays "the drain did not finish". A broken counter also aborts (except with
   `ALLOW_UNKNOWN_RUNS=1`).
6. The new `image:` line in the override and `docker compose up -d --no-deps <service>`: only
   the server service is recreated.
7. The `/api/health` check (`verify-health.sh`): `status` is `ok`, the version and commit
   match.
7b. The LLM tracing guard (`tracing-check.sh`, TRACING-HEALTH), three checks, each skipped when its
   settings are absent:
   - the callback set is the OTLP-only one: a legacy `langfuse` callback is refused while the Langfuse
     server is v4 (`GET <MYRMIDON_TRACING_LANGFUSE_URL>/api/public/health` reports 4.x) or while the
     version cannot be proven (the bundle pins it in `MYRMIDON_TRACING_LANGFUSE_VERSION`);
   - the install delivers: `MYRMIDON_TRACING_DELIVERY_COMMAND` prints the OTEL event count of
     `events_core` and the LiteLLM SpendLogs request count over
     `MYRMIDON_TRACING_DELIVERY_WINDOW_SEC` (15 min by default); zero events with traffic, a ratio
     below 50 %, or unreadable counts are refused;
   - `MYRMIDON_TRACING_LANGFUSE_IMAGE` and `MYRMIDON_TRACING_GATEWAY_IMAGE` carry a full `X.Y.Z` tag or
     a digest (a major tag such as `langfuse/langfuse:4` is refused).
   v4 in `events_only` mode rejects the legacy `/api/public/ingestion` endpoint: about 12k rejected
   events per hour and burned gateway CPU while everything looked healthy. A refusal fails the deploy
   like a failed health check (maintenance stays on, the rollback command is printed) and there is no
   flag that skips it. Without any `MYRMIDON_TRACING_*` setting the step logs a skip and the deploy
   continues.
   The release pins the tracing pair together. `scripts/myrmidon/tracing/tracing-image-pins.json` names
   the Langfuse v4 server, its worker and the LiteLLM gateway images of the bundle, and the tracing
   contract test (`docker/tracing/tracing-contract-check.sh`, `docker/tracing/docker-compose.contract.yml`)
   runs exactly that pair. A bump of ONE image alone ships a Langfuse/LiteLLM combination that the
   contract test never ran — the 02.10 mismatch class. Re-run `docker/tracing/tracing-contract-check.sh`
   before the release, and keep `tracing-image-pins.json` equal to the contract compose. The
   release-support surface resolves these components from that file (`check-release-support.sh
   --tracing-pins`).
8. Leaving maintenance mode. The `exit` call returns as soon as the server marks the window
   `leaving` (the leave tail — resuming the queue, the exit hook, retiring the window — runs on
   the server's maintenance tick), and the script then waits for the window to retire: it polls
   `GET /api/myrmidon/maintenance` until the instance state is `off` (no instance window),
   bounded by `MAINTENANCE_EXIT_WAIT_SEC` (default 120 s). A timeout is logged loudly and does
   **not** fail an otherwise switched and healthy deploy: the window stays `leaving`, which
   already reopens admission. A failed `exit` call itself still aborts, because the window would
   stay `on`. The same step runs the post-deploy fleet check (`myrmidon(POST-DEPLOY-CHECK)`):
   with `BOARD_API_URL` and `BOARD_COMPANY_ID` set, the script asks the board for issues that
   are `blocked` with an update since the deploy started, and re-reads the maintenance state. A
   blocked issue in the deploy window, an unreadable board or a window that did not retire
   prints `degraded: ...` and the run ends with `DEPLOY DEGRADED`; it does not fail a switched
   and healthy deploy. Without the two settings the check is skipped with a log line — set
   both for a release deploy: `BOARD_API_URL` is the API root with the `/api` suffix (the
   check reads `$BOARD_API_URL/companies/$BOARD_COMPANY_ID/issues?status=blocked&...`), and
   `BOARD_COMPANY_ID` is the company UUID the fleet works for.
9. The release components roll out in the same run (see
   [Deploy the board and the release components together](#deploy-the-board-and-the-release-components-together)):
   one `rollout-component.sh` per component — pull by digest, the component override file,
   a service recreate, the required health probe. A failed component marks the deploy
   DEGRADED and prints the rollback commands.
10. The post-deploy smoke (`bot-apply-smoke.sh`): within `MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC`
    (300 s by default) at least one bot container of `MYRMIDON_DEPLOY_SMOKE_COMPANY` must
    re-apply (its status is `running`). On failure the deploy reports DEGRADED with the
    rollback commands. With the company unset the smoke is skipped with a warning;
    `MYRMIDON_DEPLOY_SMOKE=0` disables it entirely (not for a release).

If step 7 or 7b fails, the script exits with an error, **maintenance stays on**, and the output
carries the rollback command and the dump path. A failure at steps 9–10 happens after the
board is healthy and maintenance is already lifted: the script exits with an error and the
DEGRADED line, and the rollback of the board and of each component is the operator's call.

`--dry-run` changes nothing (does not pull the image, does not dump, does not touch files)
and prints the plan. The image check (step 0) does run in it: it only reads.

## One boot path (systemd unit)

The board container must be started at boot from **the same compose files the
deploy scripts manage**. The 01.10 incident: a vendor-era `paperclip.service`
ran `docker compose up -d` with the vendor compose file, and for 7 minutes the
board ran the old `paperclip:2026.916.1` image on a database already migrated
to 1.3.0.

`deploy.sh` verifies this **before anything changes** (step 0, alongside the
CI-image check, also in `--dry-run`): the unit `paperclip.service` must start
the server with `docker compose --project-directory <COMPOSE_DIR>` and exactly
the `-f` files this deploy manages (`COMPOSE_FILES` plus the override). A unit
that reads another compose file, another directory, or misses the override file
is a refusal — nothing is pulled, dumped or switched. There is no flag that
skips it (`--force` does not skip it either).

- The canonical unit ships as
  [`paperclip.service.template`](../../scripts/myrmidon/deploy/paperclip.service.template):
  `After=docker.service` (the nginx lesson: nothing that needs the docker
  bridge address may start before docker), `Wants=network-online.target`, and
  `ExecStart` naming the compose files of the installation. Install it once:
  either copy the filled template to `/etc/systemd/system/paperclip.service`
  by hand, or set `SYSTEMD_UNIT_INSTALL=1` in the settings file (the deploy
  then installs it when it does not exist yet; needs root).
- `SYSTEMD_UNIT_INSTALL=1` **never overwrites an existing unit**: a foreign
  unit is a refusal, because silently replacing an unknown boot path is how
  the incident happened. Remove or fix the foreign unit by hand, then deploy.
- The unit references the compose **files**, not a digest: a new deploy writes
  the new digest into the override file and the next boot picks it up with no
  unit edit.
- The settings file can point `SYSTEMD_UNIT_DIR` elsewhere (a stand VM, a
  sandbox); the check is the same.

## Post-boot check

A systemd oneshot `myrmidon-post-boot.service` (template:
[`myrmidon-post-boot.service.template`](../../scripts/myrmidon/deploy/myrmidon-post-boot.service.template))
runs after `docker.service`, `paperclip.service` and `nginx.service` and calls
[`post-boot-check.sh`](../../scripts/myrmidon/deploy/post-boot-check.sh) with
the same settings file the deploy uses. It checks:

1. the board `/api/health` reports `status: ok` **and** the running server
   container matches the image pinned in the override file (a boot that
   resurrected a different image is a failure);
2. the dockergate container runs the image recorded in `DOCKERGATE_EXPECT_IMAGE`
   (empty: the check is off with a log line);
3. every `myrmidon-bot-*` container is running, and dockergate shows no deny
   lines since boot (`DOCKERGATE_LOGS_COMMAND`);
4. nginx, LiteLLM, RAGFlow and Hindsight answer their check URLs (each URL
   unset: the check is off with a log line — nothing is silently skipped);
5. the DNS names other services use resolve on the docker network
   (`DNS_CHECK_NAMES`, default `mysql es01 paperclip-server-1` — the RAGFlow
   lesson);
6. `systemctl --failed` is empty.

Every failure is listed (not just the first), the script exits 1 and the unit
shows as failed in `systemctl --failed`. The machine-readable report goes to
`$STATE_DIR/post-boot-check.json` — for the on-duty role's board issue, never
to the owner directly.

## Reboot rehearsal on the stand VM

Before a production release, prove the boot path on the stand VM
(`myrmidon-stand`, see [The release staging host](#the-release-staging-host)):

1. install the units: the canonical `paperclip.service` and
   `myrmidon-post-boot.service` (fill `__DEPLOY_ENV__` with the settings file
   path; `SYSTEMD_UNIT_INSTALL=1` installs the first one via a deploy);
2. run a deploy by digest (or a fresh install), let the board come up healthy;
3. reboot the VM;
4. after the boot settles, read the outcome: `systemctl --no-pager status
   myrmidon-post-boot.service` (must be `active (exited)`) and
   `$STATE_DIR/post-boot-check.json` (`ok: true`), plus `systemctl --failed`
   (must be empty).

Pass: the post-boot check reports green. A wrong boot path (a unit reading
another compose file) is caught earlier: the deploy itself refuses. Attach the
rehearsal log (the check output plus the JSON report) to the release task; for
the Myrmidon release notes it is the acceptance record that the release
survives a reboot.

## Rollback

```sh
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env            # to the previous image
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<64 hex>
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to-image ghcr.io/paperclipai/paperclip:2026.916.1
```

Without `--to`/`--to-image` the rollback takes the image remembered at the last deploy —
including the vendor image on the first switch to the fork. The rollback restores the image
and checks health against the old image's labels. **The database is not restored.**

A rollback is the emergency path and is **not blocked** by the CI-only check: the image
recorded by `deploy.sh` as previous is restored wherever it came from. But the target is
checked the same way `deploy.sh` checks a new image (reference, registry, labels, commit)
and, when it does not pass, the script prints `WARNING: rollback target is not a verified CI
image: <reason>` and continues. The warning is expected on the first rollback to a vendor
image, or to an image built by hand before this rule existed: it is not in the registry. This
way the next operator sees the rollback goes to an unverified image. Vendor migrations are
one-way: the old image usually works on the new schema, and a dump restore erases everything
written after it. If the old image does not start on the new schema, restore as a separate
explicit step:

```sh
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<old> \
  --restore-dump /path/to/myrmidon-<time>-<digest>.dump
```

The script asks to type `RESTORE` (or takes `--yes-restore-database`), stops the server
service, runs `RESTORE_COMMAND`, then brings the old image up.

### Откат на локальный образ (ROLLBACK-LOCAL)

Образы до 1.1.0 не лежат в реестре, а реестр может быть недоступен именно в момент инцидента.
`--local` откатывает на образ, который уже есть на хосте выката, **без скачивания**:

```sh
# локальный тег
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --local myrmidon-local:hotfix
# тот же дайджест, что и обычно, но без pull
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --local sha256:<64 hex>
# откат на --to/--to-image без pull
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<old> --local
```

- Ссылка берётся из аргумента `--local` (тег или дайджест; голый дайджест дополняется до
  `ghcr.io/itkadr-git/myrmidon@sha256:…`), из `MYRMIDON_ROLLBACK_LOCAL` в файле настроек
  (действует, когда `--local` не передан), а голый `--local` без значения — из `--to`/`--to-image`.
  Явный `--local <ссылка>` вместе с `--to`/`--to-image` — ошибка: ссылка одна.
- Наличие образа проверяется через `docker image inspect` **до любых изменений**. Образа нет —
  откат прекращается с ошибкой и списком локальных тегов/дайджестов этого репозитория
  (`docker image ls <repo>`), чтобы опечатка в теге не превращалась в голое «No such image».
- В этом режиме реестр не читается вовсе: ни `pull`, ни проверка «только из CI» — локальный
  образ и так не мог пройти CI, а предупреждение о не-CI образе здесь бесполезно
  (это его основной сценарий). Остальные шаги (maintenance, смена `image:`, health) — как в
  обычном откате.
- Помните: локальный образ на хосте ничем не защищён от подмены — право записи на хост
  выката и есть граница доверия. `--dry-run` печатает план без изменений.

## Что проверить после выката
A release component rolls back separately, without touching the board:
```sh
scripts/myrmidon/deploy/rollback-component.sh --config /path/to/deploy.env --component dockergate
```

It restores the image the component's rollout remembered as previous (`$STATE_DIR/
previous-<component>-image`, or an explicit `--to-image <ref>`), recreates the service and
re-runs that component's health probe (skipped with a warning when the probe is unset).
The rollback honors `MYR_<COMPONENT>_HOST` exactly like the rollout: a `remote:<user>@<host>`
component is pulled, switched and recreated on that host through ssh, a `skip` component is
left to its own procedure (a loud SKIP). Like
`rollback.sh` it is the emergency path: an unverified target warns but does not block.
Rolling the board back does not roll the components back, and rolling a component back does
not touch the board: after a DEGRADED deploy the output names exactly which side failed and
which command to run.

## Deploy from the interface

The board can start its own deploy: the instance settings ("Board update") verify a digest,
open a maintenance window, hand the switch to a host executor and follow it to health. The
rules are the script's rules, not a second policy:

- the same CI-image check (reference, registry, labels, commit on main or a myr-v* tag) runs
  BEFORE the maintenance window opens — a refused image changes nothing, not even run
  admission; there is no flag that skips it;
- one deploy at a time: while a job is open, a second one is a 409;
- the maintenance window is instance-wide, reason `deploy <digest prefix>`, and it is left
  when the job ends; on a failed health check it STAYS ON for the rollback (the same
  contract as step 7 of the script);
- the board never runs docker itself. The host half is
  `scripts/myrmidon/deploy/deploy-from-job.sh`, which polls the board API, waits for the
  window to be `on`, runs the same `deploy.sh` (dump, drain, health) and writes a small JSON
  report per job (`$STATE_DIR/job-<id>.json`). Mount that directory read-only into the board
  container as `MYRMIDON_DEPLOY_REPORTS_DIR`; the board reads it, it never writes there.
  Because the executor runs the same `deploy.sh`, the release gate applies here too: the
  components of the release roll in the same job, and a failed component rollout or smoke
  fails the job with the DEGRADED line in its log (`$STATE_DIR/job-<id>.log`);
- the job is marked succeeded only when the board's own `/api/health` agrees with the
  reported version and commit — a lying report cannot close a failed deploy;
- a job stuck in one step longer than `MYRMIDON_DEPLOY_STEP_TIMEOUT_SEC` aborts itself and
  leaves the window;
- **when the health check fails, the board rolls back automatically (R5-C).** The executor
  immediately runs `rollback.sh` to the image `deploy.sh` remembered before the switch —
  the locally known previous image (the rollback is the emergency path, so its CI-image
  check only warns) — and reports `rolling-back`, then `rolled-back` (the previous image
  is healthy again; the job ends `auto_rolled_back` and the maintenance window leaves: no
  human took part) or `rollback-failed` (the job ends `failed_rollback` and the window
  STAYS ON for the operator). `MYRMIDON_DEPLOY_AUTO_ROLLBACK=0` restores the manual
  contract: the job ends `failed_health` with the window on and the rollback is the
  operator's. The host side of the same switch is `AUTO_ROLLBACK` in `deploy.env` (1 by
  default); both sides should agree;
- **auto-update without a confirmation stays off (`MYRMIDON_DEPLOY_AUTO_UPDATE`, R5-C).**
  Every deploy from the interface waits for an explicit confirmation; enabling unattended
  deploys is a decision for after the release scenario has run on the staging stand
  (STAND). The flag exists, is documented, and defaults to off.

### Enabling it

Everything is off by default (`MYRMIDON_DEPLOY_ENABLED` unset). To switch it on:

1. `MYRMIDON_DEPLOY_ENABLED=1` in the board environment;
2. `MYRMIDON_DEPLOY_HEALTH_URL` — the board's own health endpoint as the board container
   reaches it (for example `http://127.0.0.1:3100/api/health`);
3. `MYRMIDON_DEPLOY_REPORTS_DIR` — the mounted reports directory (the host's `$STATE_DIR`);
4. on the host: the executor (`deploy-from-job.sh --config <deploy.env>`), a timer or a
   terminal session. It needs `BOARD_API_URL` (and `BOARD_TOKEN_FILE` in `authenticated`
   mode — a board API key file, mode 0600, the same one `HEALTH_TOKEN_FILE` uses).

The board reads the registry and GitHub itself for the digest check. When the board
container cannot reach them, `MYRMIDON_DEPLOY_REGISTRY_INSPECT_URL` points at a read-only
inspect endpoint answering `?ref=<reference>` with the `imagetools inspect` JSON, and
`MYRMIDON_DEPLOY_GITHUB_HEADERS_JSON` adds headers to the GitHub calls (never a token
value in the environment of a public deployment file).

### When the button, when the script

The interface is for routine deploys: the digest comes from a green CI run on `main` or a
`myr-v*` tag, the board is reachable, the executor runs. The script stays the path for the
first deploy of an installation, for a broken board (it cannot deploy itself), and for every
case the interface refuses — which is exactly the case the script would refuse too.

## What to check after a deploy

- `/api/health`: `status: ok`, the version and commit as in the image summary; `maintenance`
  is off.
- The component probes of the release gate: the deploy output ends with
  `release gate passed: board and <components> rolled out together, bots re-apply`. Each
  component answers its own probe (the exact target is your `MYR_<COMPONENT>_HEALTH_URL`).
- The server log: migrations applied, no startup errors:
  `docker compose logs --since 10m <service>`.
- Ad-hoc operator indexes: a migration may drop indexes created by hand outside the
  migration history (the release migration drops the `myr_hotfix_*` expression indexes
  once the hot-path predicates are uuid-typed). When the database was touched by hand,
  compare it with the schema after the deploy: `pnpm db:generate` in a checkout of the
  deployed tag must report no drift.
- The interface opens, the agent list is in place, an issue opens.
- Runs start again: queued wakes are delivered, a new run goes through.
- Bot containers after a release that touches the reconciler or dockergate: for 30 minutes after
  the deploy the board log must carry no `bot container recreated for a template change` and no
  `bot container template drift detected` for a card nobody changed (including across a host
  reboot). A real card change (for example `memoryMb`) still recreates that bot exactly once. When
  one does appear, the drift line names the field and both values.
- The plugins (hindsight and the rest) are `ready` in the plugin settings.
- `$STATE_DIR/history.log` has the deploy line.

## The release staging host

Before a production deploy, a release is verified on a separate VM on a copy of the
production database.

**Resources.** Not less than the production installation in memory and in disk for the
database; less CPU is fine. Disk for the image (several GB), the database copy and its dump.

**Setup.**

1. A separate VM without access to the production services: its own networks, its own
   secrets, a different address.
2. The same compose as on the production installation, with the override file pinned to the
   digest under test.
3. The latest production dump restored into the staging database.
4. External integrations off before the server starts:
   - chats (Telegram and others) — bot tokens unset or replaced with test ones;
   - mail — sending off;
   - telemetry and the announcements feed — off (that is the default);
   - all agents paused, routines off — runs must not follow production issues;
   - model keys — test ones or empty.

**Smoke checks.**

1. `verify-health.sh --url <staging address>/api/health --expect-version … --expect-commit …`.
2. The log: all migrations applied, no re-application.
3. The agent list opens and matches production.
4. An issue with a long history opens.
5. A short run with a test adapter (`process` or `http` against a stub) reaches `succeeded`.
6. The plugins come up (hindsight is mandatory).
7. A deploy from the previous digest to the new one and a rollback back, by the scripts of
   this directory, pass on the staging host.

**You may deploy when:**

- every check above has passed;
- CI on the release commit is green, the image was built by the **Myrmidon image** workflow,
  the digest is recorded (`deploy.sh` will not deploy without it anyway: the image check is
  mandatory);
- there are no new errors in the server log on the staging host for the duration of the
  checks;
- the rollback on the staging host has passed and the server is healthy after it.

**The GitHub Release is created by CI, not by hand.** Pushing a `myr-vX.Y.Z` tag
triggers the **Myrmidon release publish** workflow
([myrmidon-release.yml](https://github.com/itkadr-git/myrmidon/blob/main/.github/workflows/myrmidon-release.yml)):
it waits for the tag's `Myrmidon CI` run and the image workflows to succeed,
then creates the Release (Latest) with the `## X.Y.Z` section of
[CHANGELOG.md](CHANGELOG.md) and the component image digests, and marks the
previous release "(superseded)". A failed CI run produces no Release. To
re-run it (for example after fixing a failed gate, or to refresh the body):
Actions → Myrmidon release publish → Run workflow → the tag name in the `tag`
input; the publish is idempotent — an existing Release is updated, not
duplicated.
