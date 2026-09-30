# hermes-agent: what we change on top of upstream

**Status: current for the pinned release `v2026.9.24` (hermes `0.21.5`).**
English-only on purpose: this file is part of the open repository.

The bot runtime images (`myrmidon-hermes`, `myrmidon-hermes-node`) install
hermes-agent from a pinned upstream tag (`docker/bot-runtime/Dockerfile`,
`HERMES_GIT_REF`/`HERMES_GIT_SHA`/`HERMES_VERSION`). Everything we add or change
on top of that tag is a *delta*, and the goal is to keep the list short: a delta
stays only while upstream (or the plugin's own authors) do not carry it, and it
leaves as soon as they do.

Two machine-readable companions:

- `docker/bot-runtime/patches/*.patch` — the code deltas, applied with `git apply`
  at image build time. `docker/bot-runtime/patches/README.md` explains what each
  one does and how the reference checkout compares to the tag.
- `scripts/myrmidon/hermes-upstream/deltas.json` — this list in machine form, with
  a probe per delta; `scripts/myrmidon/hermes-upstream/hermes-upstream-check.mjs`
  compares it against upstream releases and flags the deltas that can be dropped.

## How to re-check

```sh
node scripts/myrmidon/hermes-upstream/hermes-upstream-check.mjs          # report
node scripts/myrmidon/hermes-upstream/hermes-upstream-check.mjs --json   # for automation
```

The script reports the newest stable upstream tag, says whether our pin is behind,
and for every delta prints whether upstream already carries it (`MAY BE DROPPABLE`),
still does not (`still needed`), or could not be checked. It never moves the pin:
dropping a delta is a human decision, because the probe is a marker match, not a
proof of equivalence.

This is the hermes-agent half of the board's stack-update tracking (STACK-UPDATES):
the registry row set is stable, the probe results feed the "is upstream ahead of us,
and does it close one of our patches" question. A new release is noticed by running
the script (or a routine calling it), not by reading release notes by hand.

## Deltas at `v2026.9.24`

| Delta | Kind | What and why | Drop when | Offered upstream |
|---|---|---|---|---|
| `02-session-snapshot-secret-redaction` | patch, `tools/environments/base.py`, `base_session_env.py` | The bash session snapshot is written to a shared temp dir, and every profile in a container runs as one uid, so a dumped run secret was readable by a neighbouring profile. Credential-shaped env **names** are excluded from the dump; their values still reach every command through the inherited process env. | Upstream excludes credential-shaped names from the snapshot itself (`tools/environments/base_session_env.py`). | Not offered yet — see below. |
| `04-state-read-retry-when-locked` | patch, `hermes_state.py` | The write path waits out a busy database, but reads replayed only `disk I/O error`. With one persistent gateway per bot, two concurrent runs of one agent (a writer and a session-history reader) made the reader fail with `database is locked`. Reads now retry a lock with a bounded, jittered back-off on the same connection; the existing `disk I/O error` budget is unchanged. | Upstream retries a locked read in `_read_retrying_ioerr`. | Not offered yet — see below. |
| `05-gateway-executor-pool` | patch, `gateway/run.py` | The stock asyncio default executor is small, and a live run holds one worker for its whole life; the board's `POST /v1/runs` create calls queued behind parallel runs and timed out. `start_gateway` sizes the loop's default executor from `HERMES_GATEWAY_EXECUTOR_WORKERS` (default 64) before anything else runs. | Upstream sizes the gateway's default executor above the fleet's concurrent runs, or ships an equivalent setting. | Not offered yet — see below. |
| `hindsight-reflect-timeout-and-fact-types` | upstream plugin gap (not a patch we carry) | The catalog Hindsight plugin uses one shared client timeout for recall, retain and reflect, and cannot skip the expensive consolidated-observations layer, so a `reflect` call routinely outlives a recall-sized timeout. The in-tree provider we used to patch had a reflect-specific timeout, a fact-type filter and a retry on the bank's `503` admission refusal. | The catalog plugin gains a reflect-specific (or per-operation) timeout, a reflect fact-type filter, or the `503` retry. | Not offered yet — see below. |

## Deltas that are gone

These used to be patches in this image and are dropped at `v2026.9.24`. They stay
listed here so a reader of an older commit can see where they went.

| Delta | Where it went |
|---|---|
| `01-hindsight-reflect-timeout-and-retry` | The provider left the hermes tree in 0.21.5 (it lives in the hermes plugin catalog and is maintained by its authors), so there is no in-tree file to patch. What it fixed that the plugin still does not cover is tracked as the `hindsight-reflect-timeout-and-fact-types` delta above. |
| `03-hindsight-tool-retain-async` | Closed upstream: the catalog plugin (`hindsight-integrations/hermes`, pinned at `plugin-catalog/hindsight.yaml`) passes the configured `retain_async` in the explicit retain tool. |

## Not deltas

- **Hindsight itself.** The provider is not our code and not a fork. The image
  vendors the exact commit the bundled hermes plugin catalog entry pins
  (`plugin-catalog/hindsight.yaml`: repository, subdirectory, 40-character commit),
  verifies it at build time, installs the dependencies the plugin declares through
  hermes' own plugin installer, and the container entrypoint links it into the bot's
  home. Bumping it means bumping the catalog pin in the hermes tag we install —
  one line, reviewed upstream.
- **The board-side memory plugin** (`packages/plugins/hindsight-paperclip`, the
  per-agent bank routing fork of `@vectorize-io/hindsight-paperclip`) is a Myrmidon
  component, not a hermes delta. It is tracked with the other third-party plugins in
  `scripts/myrmidon/plugin-compat/plugins.json`.

## Why nothing is offered to the authors yet

The three hermes deltas and the plugin gap are all candidates to offer upstream as
an issue or a PR, and the owner's decision is to do exactly that. They have not been
submitted from this repository's engineering sandbox, for one concrete reason: the
plan's `PUBLISH-SCAN` item (bots publish to third parties only through the
secret-scanning wrapper) is not built yet, so there is no reviewed path for a bot to
publish to `NousResearch/hermes-agent` or `vectorize-io/hindsight` under the
company's account. The text of each offer is kept with the ticket; the operator
submits it (or asks for the wrapper first). Once an offer is open, its link replaces
this paragraph per delta — the `offer` field in
`scripts/myrmidon/hermes-upstream/deltas.json` is where it goes, and the checker
prints it next to the drop condition.

When an offer is merged upstream (or into the plugin), the delta is dropped in a
separate change: remove the patch file, the registry row and the row here, and bump
the pin if the fix is only in a newer tag. That keeps the list short over time,
which is the point.