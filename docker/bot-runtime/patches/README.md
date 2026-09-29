# Patches applied to the hermes client at build time

This is where our patches to the `hermes-agent` client land, applied at
image build time against the pinned upstream tag (`HERMES_GIT_REF` in
`docker/bot-runtime/Dockerfile`, currently `v2026.9.11`, the tag that ships hermes's pyproject.toml version 0.21.2).

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
git clone --branch v2026.9.11 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-check
cd /tmp/hermes-check
for p in /path/to/docker/bot-runtime/patches/*.patch; do git apply --whitespace=fix "$p"; done
diff -rq --exclude=.git --exclude=__pycache__ . <reference>
```

## Reference checkout versus this image

| File in the reference checkout | What it changes there | Decision |
|---|---|---|
| `plugins/memory/hindsight/__init__.py`, `settings.py` | `reflect` timeout, reflect fact-type filter, bounded retry on `503`, `retain_async` in the explicit retain tool | **Ported** — patches 01 and 03. |
| `tools/environments/base.py`, `base_session_env.py` | credential-shaped env names kept out of the session snapshot | **Ported** — patch 02. |
| `hermes_state.py` | a read that finds the state database locked is retried with a bounded back-off | **Ported** — patch 04, with the attempt count and delays as fixed constants. The reference reads the same three numbers from optional `HERMES_READ_LOCKED_RETRY_*` variables; those knobs are not carried (nothing in this image needs to tune them, and every new variable is one more documented setting). |
| `plugins/memory/hindsight/README.md` | documents the `reflect_fact_types` option | **Not needed** — documentation of an option that patch 01 already ports; the option is described in the table below. |
| `agent/chat_completion_helpers.py` | persists `reasoning_content` in a stored assistant message only on routes that echo it back | **Not ported.** A storage-only optimization: it avoids keeping a second copy of the reasoning text in `state.db` on routes that never send it back. It fixes no defect, because the replay path (`apply_reasoning_content_policy`) already strips the field for such routes and rebuilds or pads it for echo routes, so a message stored without it replays correctly. It sits in the message-persistence path of a large upstream file. Port it as a reviewed patch if measured `state.db` growth in long-lived bot containers makes the duplicate copy a real cost. |
| `cli.py` | escapes markup in the `Query:` label printed by single-query CLI mode | **Not needed** — that path is `hermes chat -q`; this image runs `hermes gateway run` and never enters it. |
| `tools/browser_tool.py`, `tools/browser_tool_session.py` | short socket directory for the `agent-browser` CLI, honoring an externally pinned socket dir | **Not needed** — the browser tool drives the `agent-browser` Node CLI and a Chromium. This image ships neither (no Node, no browser package; lazy installs are disabled), so the tool cannot run. If a browser is ever added to the image, port these two files together with it. |
| tests added in the reference checkout (`tests/`) | tests for the changes above | **Not shipped** — the build removes `tests/` from the image, and the patches here are checked by `git apply` at build time and by the guards in `scripts/myrmidon/bot-runtime/`. |

Files that exist only in the reference checkout and are not source
modifications (a bytecode fingerprint file and the editable install's
`egg-info` directory) are install artifacts and are not patched anywhere.

## How a patch is added

1. Write the change against a fresh clone of the pinned tag:
   ```sh
   git clone --branch v2026.9.11 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-check
   cd /tmp/hermes-check
   # edit, test against a real gateway run locally
   git diff > my-change.patch
   ```
2. Name the file `NN-short-description.patch` (`NN` = two-digit apply
   order, lowest first — `git apply` in the Dockerfile loop applies them in
   `for p in /tmp/patches/*.patch` glob order, i.e. sorted filename order).
3. Add a row to the Patches table below: what it changes, why, and how to
   tell when it can be dropped (usually "upstream merged #N" or "hermes
   vX.Y.Z fixes this natively"). If the change comes from the reference
   checkout, also mark its file as ported in the comparison table above.
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
| `01-hindsight-reflect-timeout-and-retry.patch` | `plugins/memory/hindsight/settings.py` and `__init__.py`: a `reflect`-specific client timeout (`reflect_timeout` / `HINDSIGHT_REFLECT_TIMEOUT`, default 360s, separate from the shared `timeout`), a `reflect_fact_types` filter that skips the expensive consolidated-observations layer by default, and a bounded retry on the bank's `503` admission refusal (busy reflect lane), honoring `Retry-After`. | The shared client timeout is sized for recall/retain; a `reflect` call synthesizes an LLM answer over the whole bank and routinely runs well past it, so every `reflect` was silently killed client-side while the bank was still working. A `503` admission refusal is transient by contract; without a retry, that turn's memory call was lost outright instead of completing on the next available slot. | Upstream ships its own per-operation timeout and/or 503 retry for the hindsight client (check `plugins/memory/hindsight/` in a newer tag). |
| `02-session-snapshot-secret-redaction.patch` | `tools/environments/base.py` and `base_session_env.py`: excludes credential-shaped env var **names** (`*_SECRET`, `*_TOKEN`, `*_API_KEY`, `*_KEY`, `*_URL`, `*_DSN`, …) from the bash session-snapshot dump, in addition to the existing per-session passthrough exclusions. | The snapshot file lives in a shared temp dir; every profile in the container runs as one uid, so file permissions alone do not separate co-tenant agents. Dumping a run secret's value into that file made it readable by any neighbouring profile. The value stays available to every command via the inherited process env regardless, so excluding it from the snapshot costs nothing functionally. | Upstream adds an equivalent snapshot exclusion for credential-shaped env names (check `tools/environments/base_session_env.py` in a newer tag). |
| `03-hindsight-tool-retain-async.patch` | `plugins/memory/hindsight/__init__.py`: the explicit `hindsight_retain` tool passes the configured `retain_async` (default `true`) to the client, as the per-turn retain path already does. | Without it the client's own default applies, a synchronous retain: the tool call waits until the server has finished extracting facts, bounded only by the shared client timeout. On a busy bank that is a timeout and a false "memory not stored" error although the write was accepted. With `memory_mode: tools` and `auto_retain: false` this tool is the only retain path. | Upstream passes `retain_async` from the tool path (check `_tool_retain` in a newer tag). |
| `04-state-read-retry-when-locked.patch` | `hermes_state.py`: `_read_retrying_ioerr` also retries a read that fails with `database is locked` / `database is busy`: up to 15 retries, delay doubling from 50 ms to a 1 s cap with jitter, on the same connection; a persistent lock raises the original error, any other `OperationalError` is raised at once, and the existing `disk I/O error` budget is unchanged. | The write path already waits out a busy database, but reads replayed only `disk I/O error`. With one persistent gateway per bot, two concurrent runs of the same agent (one writing a turn, the other resuming the session history) made the reader fail with `database is locked`. In WAL mode there is exactly one writer at a time, so waiting for it is the fix, not new locking. | Upstream retries locked reads (check `_read_retrying_ioerr` in a newer tag). |
