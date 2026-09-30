# dockergate

> Russian version: [dockergate.ru.md](dockergate.ru.md)

A proxy in front of the Docker socket for the board's bot-container driver
(`server/src/myrmidon/bot-containers/`). Code: `tools/dockergate/` (Go, standard library
only), image: `docker/dockergate/Dockerfile`, publishing:
`.github/workflows/myrmidon-dockergate.yml` to `ghcr.io/itkadr-git/myrmidon-dockergate`.

## Why

The board server runs under the same uid as bots with a terminal. The board's access to the
Docker daemon socket equals host root for any such bot: a container with `Privileged`, with
`/` mounted, and so on is one call away. dockergate stands between the board and the daemon
and passes only the calls the driver makes, and only with the bodies the driver builds.
Everything else is denied (deny by default). The raw daemon socket is not mounted into the
board; the board gets the dockergate socket (`MYRMIDON_BOT_DOCKER_SOCKET`, see
[SETTINGS.md](SETTINGS.md)).

## How it is enforced

1. **The caller.** A connection is accepted only when it was opened by the pinned board
   process (`SO_PEERCRED`, then the process is checked against `/proc`): the first child of
   the board container's main process with the expected `argv`. A foreign caller gets a
   static refusal or a silent close; it does not occupy a connection slot. The
   `caller.mode: uid` mode (uid and gid only) exists for CI and is refused by the
   configuration check with a production `volumeRoot`.
2. **Routes.** The raw request-target is matched without decoding percent-escapes; only the
   template literals are allowed. Method, API version (`v1.45` only) and headers are checked
   strictly.
3. **Bodies.** A container-create body is parsed by a strict schema (an unknown key, a
   duplicate key, `null`, a fractional number or an escaped letter are rejected), then
   canonically rebuilt and compared byte for byte with the received one. The rebuild takes
   values from `bots[]`, not from the request. Tar uploads (`ustar`) are checked byte for
   byte and rebuilt the same way: types, uid/gid, modes, paths, order, content.
4. **Bot consistency.** The `botKey` comes from the container name; the label, volumes,
   network and helper script must match it. Memory, CPU and process-count limits may not
   exceed what `bots[]` records.
5. **State.** Before a call, dockergate inspects the container itself and checks the
   preconditions (the bot label, status, the presence of `.next`).
6. **Responses are cut down** to the fields the driver reads, with a size cap.

## The allowed-call table

| ID | Call | Purpose |
|---|---|---|
| A1 | `GET /v1.45/images/<ref>/json` for `ref` from `images` | image labels (the bot-environment contract) |
| A2 | `GET /v1.45/containers/myrmidon-bot-<K>/json` | container state |
| A3 | `GET .../myrmidon-bot-<K>/archive?path=<applied-profile marker>` | read the marker |
| A4 | `POST /v1.45/containers/create?name=myrmidon-bot-<K>[.next\|.helper]` | create the bot, `.next` or the helper |
| A5 | `PUT .../myrmidon-bot-<K>.helper/archive?path=<volume>&noOverwriteDirNonDir=true` | write the profile through the helper (tar) |
| A6 | `POST .../myrmidon-bot-<K>[.helper]/start` | start |
| A7 | `POST .../myrmidon-bot-<K>.helper/wait?condition=not-running` | wait for the helper |
| A8 | `GET .../myrmidon-bot-<K>.helper/logs?stdout=true&stderr=true&tail=20` | helper log |
| A9 | `DELETE .../myrmidon-bot-<K>[.next\|.helper]?force=true&v=true` | delete |
| A10 | `POST .../myrmidon-bot-<K>/stop?t=30` | stop (only inside a recreate) |
| A11 | `POST .../myrmidon-bot-<K>/restart?t=30` | restart (rate-limited) |
| A12 | `POST .../myrmidon-bot-<K>.next/rename?name=myrmidon-bot-<K>` | finish the recreate |

`K` is a lowercase UUID. Any other path (including `exec`, `attach`, `commit`, `build`,
`images/create`, `volumes`, `networks`, `info`, `events`, `system`, `swarm`) gets 403
`route_not_allowed`.

## Configuration

A JSON file. An unknown key at any level, or a missing required key, prevents startup
(`check-config` and `serve` exit non-zero).

| Key | Meaning |
|---|---|
| `listen` | absolute path of the dockergate socket |
| `upstream` | absolute path of the daemon socket |
| `apiVersion` | `1.45` only |
| `caller` | required. `container` (the board container name), `containerLabels`, `uid`, `gid`, `argv`, `maxStartDelayTicks`, `mode` (`container-main-process` by default, `uid` for CI only) |
| `volumeRoot` | the host directory of bot volumes; a bot's volumes are `<root>/<botKey>/{hermes,workspace,scratch}` |
| `network` | the single bot network |
| `images` | a non-empty list of images, by digest only (`name@sha256:...`); a tag is not allowed |
| `bots[]` | a bot record: `botKey`, `maxMemoryMb`, `maxCpus`, `maxPids` |
| `limits` | limits and timeouts: header and body sizes, read and upstream timeouts, connection and in-flight call counts, the global rate, the per-process refusal rate, per-bot window rates (`createPerWindow`, `startPerWindow`, `restartPerWindow`, `stopPerWindow`, `putArchivePerWindow`, `rateWindowSec`). A missing key takes the default |
| `statsFile` | absolute path of the counters file |

`SIGHUP` re-reads the file; only `bots`, `images`, `network` and `volumeRoot` are applied. An
invalid file, or one that changes anything else, is rejected and the running configuration
stays.

## Log and counters

The log (JSON, one line per decision) carries the route, `botKey`, the decision, the reason
code and, for a body-field refusal, the field path, the value length and the first 12
characters of its sha256. Request and response bodies, names from tar files, environment
values, client headers and secrets are absent by construction. Events without a decision:
`caller_decoy`, `reject_flood`, `caller_resolve_failed`, `caller_not_board_main`,
`config_reload_failed`.

Reason codes: `caller_resolve_failed`, `caller_not_board_main`, `caller_pin_stale`,
`target_form`, `method_not_allowed`, `api_version`, `route_not_allowed`, `header_forbidden`,
`content_type`, `body_not_allowed`, `body_too_large`, `json_syntax`, `json_duplicate_key`,
`json_unknown_key`, `json_type`, `json_value`, `json_not_canonical`, `bot_not_enrolled`,
`image_not_allowed`, `image_contract`, `image_user`, `helper_image_mismatch`,
`name_label_mismatch`, `binds_mismatch`, `network_mismatch`, `limit_exceeds_enrollment`,
`script_mismatch`, `nonce_invalid`, `tar_syntax`, `tar_type`, `tar_owner`, `tar_mode`,
`tar_path`, `tar_nonce`, `tar_order`, `tar_content`, `tar_too_large`, `tar_not_canonical`,
`foreign_container`, `state_precondition`, `volume_root_invariant`, `rate_limited`,
`concurrency_limited`, `upstream_error`, `upstream_timeout`, `upstream_upgrade`,
`response_too_large`, `marker_too_large`.

`statsFile` (JSON, rewritten atomically) holds only numbers and names: allows and denials by
route and reason, `denyPeer`, `rejectDropped`, `resolveFailures`, `resolveDecoys`, upstream
errors, `markerTooLarge`, `rateLimited`, the pinning state, the daemon's answer to ping, a
duration histogram by route. No values from daemon requests and responses. Useful monitoring
signals: `denyPeer` or `resolveDecoys` growing, denials beyond the expected ones,
`pinned: false`, a stale `updatedAt`.

## Enrolling a bot

1. Prepare the bot's volume directory `<volumeRoot>/<botKey>`: the directory is owned by
   root and not writable by group or others (the `CheckVolumeRoot` check rejects modes with
   group/other write bits, i.e. 0755 or stricter); the `hermes`, `workspace`, `scratch`
   subdirectories are owned by root or by the bot user (uid 10001), also without group/other
   write. Do not touch the content. (uid 65532 is the user of the dockergate container
   itself; it is unrelated to the volume owner.)
2. Add a record to `bots[]` (a structural JSON edit, not a regex) with the memory, CPU and
   process-count caps.
3. Check: `dockergate check-config --config <file>`.
4. Send `SIGHUP` to the dockergate process.

## Deploy and rollback

1. The image comes from `ghcr.io/itkadr-git/myrmidon-dockergate` strictly by digest; the OCI
   label `org.opencontainers.image.revision` is checked against a `main` commit or a
   `myr-v*` tag.
2. The socket directory `/run/myrmidon-dockergate/` is created at boot (tmpfiles) and mounted
   into the board container; the raw daemon socket is not mounted into it.
3. dockergate runs as a separate unprivileged container: user 65532, a read-only file system,
   all capabilities dropped, memory and CPU limits set; only it gets access to the daemon
   socket.
4. In the board's environment `MYRMIDON_BOT_DOCKER_SOCKET=/run/myrmidon-dockergate/engine.sock`,
   restart the board (a window without rebuilding the bots).
5. Acceptance: `check-config`, a full driver cycle (status, create, writeProfile, start,
   restart, recreate) on one bot, no denials in the log beyond the expected ones.
6. Rollback: restore the previous `MYRMIDON_BOT_DOCKER_SOCKET` value, restart the board;
   stop dockergate. The bot containers' state is unchanged by this.

## Residual risks

- A process with the board's uid that makes the board's main process issue a call through
  ptrace or `/proc/<pid>/mem` gets the driver's powers over the bots enrolled in `bots[]`
  (not host root). Mitigation: `kernel.yama.ptrace_scope=1`; complete: bots outside the board
  container.
- A connection flood from a process with the board's uid can delay a legitimate call until
  the next reconciliation pass.
- Trust in the daemon and the images: an image is checked by the digest from `images` and by
  the contract label; the dockergate image itself is not signed.

## What is not done

The first PR did not include: fuzzing, integration tests with a real dockerd, a rules matrix
`RULES.md` checked in CI, host scripts (deploy, bot enrolment, compose edits, tmpfiles), two
board tests from the `agent-self-update` side, monitoring triggers. They come as separate
PRs.
