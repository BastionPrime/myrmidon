# Patches applied to the hermes client at build time

Empty at Myrmidon 1.1.0 (G1, 2026-09-28). This is where our patches to the
`hermes-agent` client land once we need one, applied at image build time
against the pinned upstream tag (`HERMES_GIT_REF` in
`docker/bot-runtime/Dockerfile`, currently `v2026.9.11`, the tag that ships hermes's pyproject.toml version 0.21.2).

A reference `hermes-agent` checkout used while preparing this image carries
**multiple** local modifications on top of the pinned tag that are **not**
captured as `*.patch` files here. They span more than the one area a first
pass might notice — environment/session handling, some tool behavior, and
CLI/agent-loop helper code are all touched — so this is wider than a
single change. Full access to that checkout's history was not available
while preparing this image (only a partial, read-only view), so turning
these into clean, reviewed patches needs someone with full access to that
history, not a guess from a partial read.

At least one of the unported changes is security-relevant (it hardens what
gets written to disk as part of a session's state) and should not wait for
a full survey of the rest before being prioritized. **This is a known gap,
wider than a single change**, left for a maintainer or a later Этап with
full access to port properly (as reviewed, tested patches, not guesses):
do not assume `patches/` is a complete patch set, and do not stop after the
first modification found — check that checkout's full local history
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

## Patches (none yet)

| File | What it changes | Why | Drop when |
|---|---|---|---|
| — | — | — | — |
