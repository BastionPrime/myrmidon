# Patches applied to the hermes client at build time

This is where our patches to the `hermes-agent` client land, applied at
image build time against the pinned upstream tag (`HERMES_GIT_REF` in
`docker/bot-runtime/Dockerfile`, currently `v2026.9.11`, the tag that ships hermes's pyproject.toml version 0.21.2).

A reference `hermes-agent` checkout used while preparing this image carries
local modifications on top of the pinned tag. The two below — the
hindsight reflect timeout/retry behavior and the session-snapshot secret
redaction — are ported here as reviewed patches, rewritten clean against
this tag (English comments, no internal identifiers, per
`docs/myrmidon/CONVENTIONS.md` §10). Full access to that checkout's history
was not available while preparing this image (only a partial, read-only
view), so these two were confirmed by diffing the checkout directly against
a fresh clone of the pinned tag, not by reading history.

The rest of that checkout's local modifications — some tool behavior (e.g.
the browser tool) and CLI/agent-loop helper code — are **not yet** ported
here. **This is a known gap**, left for a maintainer or a later phase with
full access to port properly (as reviewed, tested patches, not guesses):
do not assume `patches/` is a complete patch set, and do not stop after the
two modifications below — check that checkout's full local history
directly before treating this list as closed.

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
3. Add a row to the table below: what it changes, why, and how to tell when
   it can be dropped (usually "upstream merged #N" or "hermes vX.Y.Z fixes
   this natively").
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
