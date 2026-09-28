# Patches applied to the hermes client at build time

Empty at Myrmidon 1.1.0 (G1, 2026-09-28). This is where our patches to the
`hermes-agent` client land once we need one, applied at image build time
against the pinned upstream tag (`HERMES_GIT_REF` in
`docker/bot-runtime/Dockerfile`, currently `v2026.9.11`, the tag that ships hermes's pyproject.toml version 0.21.2).

`/opt/hermes-agent/src` on the host does carry at least one local
modification relative to the pinned tag, **not** captured here. `.git/HEAD`
and `.git/COMMIT_EDITMSG` on that checkout are root-owned (`0600`), so
`git log`/`git diff` against the tag cannot be run directly — but
`.git/refs/heads/` is world-readable and lists a local branch (not the
pinned tag, not any upstream ref) whose tip commit is a real, non-trivial
change to `tools/environments/base.py` and
`tools/environments/base_session_env.py`, hardening what a session's
terminal-snapshot mechanism writes to disk so it stops including
credential-shaped environment variables (names matching patterns like
`*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD`, `*_URL`) in cleartext.

That commit's message and top-level tree are readable the same
world-readable way (no root needed); a full diff is not: its parent
commit's tree object is one of the majority of this repository's git
objects that *is* root-locked, so `git diff <parent>..<tip>` fails with a
permission error rather than producing output. Rewriting this into a clean
`*.patch` here would mean guessing at a security-relevant diff we cannot
actually read in full — worse than not having it. **This is a known gap**,
left for a maintainer or a later Этап with read access to the full local
history to port properly (as a reviewed, tested patch, not a guess): do not
assume `patches/` is a complete patch set without checking that checkout's
local branches directly.

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
