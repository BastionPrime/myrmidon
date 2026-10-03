# Telegram DM: editable run status and inline split of long answers

> Russian version: [telegram-dm-status.ru.md](telegram-dm-status.ru.md)

Two opt-in settings change how a bridged Telegram DM (a chat connected with
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`) shows a run. Both are off by default;
with both unset the vendor behavior is unchanged.

## Editable run status (`MYRMIDON_TELEGRAM_DM_STATUS`)

By default the bridged DM suppresses the routine run milestones ("queued",
"working") as noise, so the chat owner sees nothing until the agent's answer
arrives. With `MYRMIDON_TELEGRAM_DM_STATUS=1` the run gets exactly one
status message in the DM instead of silence:

- The status is posted once, when the run is queued, and the same message is
  edited in place as the phase changes (`queued` → `working`) — no stack of
  milestone messages.
- While the run is working, the status text is live progress, not just
  "working…": the agent's current step in plain words, the elapsed time, and
  the last few completed steps as a short list.
- The run's final answer replaces the status message.
- Failure, admin-attention and completion milestones still publish as before,
  and the terminal milestone of a turn stopped with `/stop` from the chat
  stays suppressed — the command has already answered.
- The setting is read on every sweep; no restart is needed. Groups and
  topics are unaffected — it applies to bridged DMs only.

Accepted on values: `1`, `true`, `yes`, `on`. Any other value (or unset)
keeps the vendor path unchanged.

### Live progress text

While the run is working, the one status message carries a live progress
text instead of a bare "working…":

```text
<agent name>: инструмент: web_search · 2 мин

Сделано:
• поиск завершён
• план: собрать доклад
• готово: сводка источников
```

(The step labels and the `Сделано:` heading are Russian in the product code
itself — the strings above are the literals the message carries, not
translation choices.)

- The current step is the newest step-family event of the run's own run log
  (`heartbeat_run_events`) — tool executions, research, delegations, plan
  updates, completed items — worded in Russian by fixed labels (for example
  `инструмент: <what>`, `ищу информацию…`, `помощник завершил работу`). The
  log rows are already redacted when recorded, and the label is redacted a
  second time and truncated hard (120 characters for the current step, 80
  for a completed one) before it crosses to Telegram; raw payloads, tool
  arguments and results never leave the server.
- The elapsed time sits next to the current step and advances in coarse
  30-second buckets (`<1 мин`, `2 мин`, `1 ч 5 мин`) — a per-second clock
  would force a provider edit on every sweep.
- Below the current step the last three completed steps are listed under a
  `Сделано:` heading.
- The status is edited in place only when the text actually changes: the
  sweep re-publishes a durable status row per run
  (`run:<id>:dmstatus:<endpoint>`) and re-opens the already-posted provider
  message for editing only if the composed text differs from what is stored.
  Identical text leaves the message untouched, so the elapsed time alone
  rides along with real step changes instead of flipping the row every
  sweep — this is what fixed the repeated "working…" duplicates.
- A run with no step events yet falls back to the vendor's safe wording:
  `<agent name> is working… (<elapsed>)`.

## Inline split of long answers (`MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS`)

A Telegram message is limited to 4,096 UTF-16 units. Long plain-prose
answers already arrive as several native messages (split at paragraph, line,
then word boundaries, about 1,600 code points per part). A long
**structured** Markdown answer — code fences, tables, lists — is different:
Telegram parses each message as a separate Markdown document, so splitting
would break the formatting, and by default such an answer arrives as one
`.md` file attachment.

With `MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS` set to a positive integer, a long
structured answer splits inline into at most that many ordered parts instead
of the attachment. Limits:

- A document that needs more parts than the cap still goes out as one
  attachment — the cap is a ceiling, not a stretch.
- The split is boundary-based (paragraph, line, word); joining the parts
  reconstructs the source text losslessly.
- Unset, `0`, or a value that is not a non-negative integer keeps the
  vendor's single attachment. The setting is read at delivery time; no
  restart is needed.

Both settings live in [../SETTINGS.md](../SETTINGS.md) with defaults and
accepted values.
