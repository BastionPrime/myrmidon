# Patches applied to the hermes client at build time

Empty at Myrmidon 1.1.0 (G1, 2026-09-28). This is where our patches to the
`hermes-agent` client land once we need one, applied at image build time
against the pinned upstream tag (`HERMES_GIT_REF` in
`docker/bot-runtime/Dockerfile`, currently `v0.21.2`).

We could not tell from `/opt/hermes-agent/src` on the host whether the
installed checkout already carries local modifications relative to that tag:
its `.git/HEAD` and `.git/COMMIT_EDITMSG` are owned by `root` (`0600`), not
readable by the session that wrote this Dockerfile, so `git log` / `git
diff` against the tag could not be run. If that checkout does carry
undocumented local changes, they are **not** captured here — do not assume
this directory is a complete patch set without checking `git log
v0.21.2..HEAD` on that checkout (or its origin, if it has one) directly.

## How a patch is added

1. Write the change against a fresh clone of the pinned tag:
   ```sh
   git clone --branch v0.21.2 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-check
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
