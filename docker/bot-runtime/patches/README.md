# Patches applied to the hermes client at build time

This is where our patches to the `hermes-agent` client land, applied at
image build time against the pinned upstream tag (`HERMES_GIT_REF` in
`docker/bot-runtime/Dockerfile`, currently `v2026.9.24`, the tag that ships hermes's
pyproject.toml version 0.21.5).

The machine-readable list of what we change and when each change can be
dropped lives in [`docs/myrmidon/hermes-deltas.md`](../../../docs/myrmidon/hermes-deltas.md)
(the same deltas, in English, with the reason and the status of the offer to
the author); `scripts/myrmidon/hermes-upstream/` checks that file against
upstream releases. This README is the build-time contract: the Dockerfile
applies every `*.patch` file in this directory and the guard tests in
`scripts/myrmidon/bot-runtime/dockerfile.test.mjs` fail the build if a patch
is undocumented or misnumbered.

A reference `hermes-agent` checkout used while preparing this image carries
local modifications on top of the pinned tag. Comparing it against a fresh
clone of the pinned tag with a plain tree diff (`diff -r`, no repository
history needed) gives a closed list of files. The table below states, for
every file on that list, whether a patch here carries it or it is left out on
purpose, and why. The tree diff was repeated with all patches applied to the
tag: what remains in the ported files is comments, docstrings and one
option-description string, plus the one deliberate difference noted for
`hermes_state.py`.

To repeat the comparison (`<reference>` is the reference checkout):

```sh
git clone --branch v2026.9.24 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-check
cd /tmp/hermes-check
for p in /path/to/docker/bot-runtime/patches/*.patch; do git apply --whitespace=fix "$p"; done
diff -rq --exclude=.git --exclude=__pycache__ . <reference>
```

## Reference checkout versus this image

| File in the reference checkout | What it changes there | Decision |
|---|---|---|
| `tools/environments/base.py`, `base_session_env.py` | credential-shaped env names kept out of the session snapshot | **Ported** — patch 02. |
| `hermes_state.py` | a read that finds the state database locked is retried with a bounded back-off | **Ported** — patch 04, with the attempt count and delays as fixed constants. The reference reads the same three numbers from optional `HERMES_READ_LOCKED_RETRY_*` variables; those knobs are not carried (nothing in this image needs to tune them, and every new variable is one more documented setting). |
| `gateway/run.py` | the gateway's asyncio default executor pool is sized above the fleet's concurrent runs (`HERMES_GATEWAY_EXECUTOR_WORKERS`, default 64) instead of the stock pool | **Ported** — patch 05. |
| `plugins/memory/hindsight/*` | a `reflect`-specific client timeout and 503 retry, a `reflect_fact_types` filter, and `retain_async` in the explicit retain tool | **Not patched any more.** The provider left the hermes tree in 0.21.5 (it lives in the plugin catalog now), so there is nothing here to patch. The catalog plugin already carries the `retain_async` fix; the reflect timeout/`503` retry/fact-type filter are still missing there and are tracked as a separate delta with its upstream offer — see [`docs/myrmidon/hermes-deltas.md`](../../../docs/myrmidon/hermes-deltas.md). |
| `plugins/memory/hindsight/README.md` | documents the `reflect_fact_types` option | **Not needed here** — the file is gone from the hermes tree; the option is documented with the delta that keeps it, if and when that delta is carried. |
| `agent/chat_completion_helpers.py` | persists `reasoning_content` in a stored assistant message only on routes that echo it back | **Not ported.** A storage-only optimization: it avoids keeping a second copy of the reasoning text in `state.db` on routes that never send it back. It fixes no defect, because the replay path (`apply_reasoning_content_policy`) already strips the field for such routes and rebuilds or pads it for echo routes, so a message stored without it replays correctly. It sits in the message-persistence path of a large upstream file. Port it as a reviewed patch if measured `state.db` growth in long-lived bot containers makes the duplicate copy a real cost. |
| `cli.py` | escapes markup in the `Query:` label printed by single-query CLI mode | **Not needed** — that path is `hermes chat -q`; this image runs `hermes gateway run` and never enters it. |
| `tools/browser_tool.py`, `tools/browser_tool_session.py` | short socket directory for the `agent-browser` CLI, honoring an externally pinned socket dir | **Not needed** — the browser tool drives the `agent-browser` Node CLI and a Chromium. This image ships neither (no Node, no browser package; lazy installs are disabled), so the tool cannot run. If a browser is ever added to the image, port these two files together with it. |
| tests added or changed in the reference checkout (`tests/`) | tests for the changes above | **Not shipped** — the build removes `tests/` from the image, and the patches here are checked by `git apply` at build time and by the guards in `scripts/myrmidon/bot-runtime/`. |

Files that exist only in the reference checkout and are not source
modifications (a bytecode fingerprint file, the editable install's
`egg-info` directory, and editor backup copies (`*.bak-*`) of files already
listed above) are not patched anywhere.

## How a patch is added

1. Write the change against a fresh clone of the pinned tag:
   ```sh
   git clone --branch v2026.9.24 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-check
   cd /tmp/hermes-check
   # edit, test against a real gateway run locally
   git diff > my-change.patch
   ```
2. Name the file `NN-short-description.patch` (`NN` = two-digit apply
   order, lowest first — `git apply` in the Dockerfile loop applies them in
   `for p in /tmp/patches/*.patch` glob order, i.e. sorted filename order).
   Numbers already used are not reused: a dropped patch leaves its number
   free forever so a reader of an old commit and a reader of a new one are
   looking at the same file.
3. Add a row to the Patches table below: what it changes, why, and how to
   tell when it can be dropped (usually "upstream merged #N" or "hermes
   vX.Y.Z fixes this natively"). Add the same delta to
   `docs/myrmidon/hermes-deltas.md` with its upstream offer, so the drop
   condition is machine-checkable by `scripts/myrmidon/hermes-upstream/`.
4. Do **not** copy a patch out of `myrmidon-deploy` (or any other private
   repo) as-is — per `docs/myrmidon/CONVENTIONS.md` §10, rewrite it clean
   against this tag with English comments and no internal identifiers.
5. `docker/bot-runtime/Dockerfile`'s builder stage applies every
   `*.patch` file here with `git apply --whitespace=fix` before `uv sync`,
   inside the cloned `/opt/hermes-src` checkout. A patch that does not
   apply cleanly against the current `HERMES_GIT_REF` fails the image build
   loudly (`git apply` exits non-zero) rather than silently skipping.
6. hermes-agent's `setup.py` refuses to build a wheel/sdist outside a Nix
   build — patches only need to survive an **editable** install
   (`uv sync`), the supported path this image uses. See the Dockerfile's
   header comment.

## Patches

| File | What it changes | Why | Drop when |
|---|---|---|---|
| `02-session-snapshot-secret-redaction.patch` | `tools/environments/base.py` and `base_session_env.py`: excludes credential-shaped env var **names** (`*_SECRET`, `*_TOKEN`, `*_API_KEY`, `*_KEY`, `*_URL`, `*_DSN`, …) from the bash session-snapshot dump, in addition to the existing per-session passthrough exclusions. | The snapshot file lives in a shared temp dir; every profile in the container runs as one uid, so file permissions alone do not separate co-tenant agents. Dumping a run secret's value into that file made it readable by any neighbouring profile. The value stays available to every command via the inherited process env regardless, so excluding it from the snapshot costs nothing functionally. | Upstream adds an equivalent snapshot exclusion for credential-shaped env names (check `tools/environments/base_session_env.py` in a newer tag). |
| `04-state-read-retry-when-locked.patch` | `hermes_state.py`: `_read_retrying_ioerr` also retries a read that fails with `database is locked` / `database is busy`: up to 15 retries, delay doubling from 50 ms to a 1 s cap with jitter, on the same connection; a persistent lock raises the original error, any other `OperationalError` is raised at once, and the existing `disk I/O error` budget is unchanged. The pauses alone add up to about 6-17 s, but a persistent lock surfaces after up to about 95 s: each of the 16 attempts (the first plus 15 retries) can first wait up to 5 s in the busy timeout of the pooled read connection (`_connect_read_only(timeout=_READ_BUSY_TIMEOUT_S)` in `_get_read_conn`), on top of the pauses. | The write path already waits out a busy database, but reads replayed only `disk I/O error`. With one persistent gateway per bot, two concurrent runs of the same agent (one writing a turn, the other resuming the session history) made the reader fail with `database is locked`. In WAL mode there is exactly one writer at a time, so waiting for it is the fix, not new locking. | Upstream retries locked reads (check `_read_retrying_ioerr` in a newer tag). |
| `05-gateway-executor-pool.patch` | `gateway/run.py`: `start_gateway` sizes the running loop's default executor (`concurrent.futures.ThreadPoolExecutor`) from `HERMES_GATEWAY_EXECUTOR_WORKERS`, default 64, before anything else in the function runs. | The stock asyncio pool is small, and a bot gateway keeps one worker busy for the whole life of each live run, so the board's `POST /v1/runs` create calls queued behind them and timed out under parallel load. Sizing the pool above the fleet's concurrent runs fixes the timeouts without touching the run lifecycle. | Upstream ships a gateway sizing whose default is above the fleet's concurrent runs, or an equivalent setting (check the default-executor setup in `start_gateway`). |