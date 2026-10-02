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
- The run's final answer replaces the status message.
- Failure, admin-attention and completion milestones still publish as before,
  and the terminal milestone of a turn stopped with `/stop` from the chat
  stays suppressed — the command has already answered.
- The setting is read on every sweep; no restart is needed. Groups and
  topics are unaffected — it applies to bridged DMs only.

Accepted on values: `1`, `true`, `yes`, `on`. Any other value (or unset)
keeps the vendor path unchanged.

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
