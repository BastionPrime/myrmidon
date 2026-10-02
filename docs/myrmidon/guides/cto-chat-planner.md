# The board chat planner: owner text to a proposed epic (CTO-CHAT B)

> Russian version: [cto-chat-planner.ru.md](cto-chat-planner.ru.md)

One owner message in free text becomes a proposed epic with child tasks and
per-task acceptance criteria; the proposal is shown as an approval card, and
accepting the card is what creates the tasks. Nothing is planned into the board
behind the owner's back: a proposal is an answer the owner reviews, and the only
durable thing it produces is the card.

This guide covers the server half of the 1.6 CTO-CHAT epic (part B): the
planning route, the approval card and the Telegram entry
(`server/src/myrmidon/cto-chat/`). The portal chat screen (part A — the
Commander chat of the UI 2.0 shell, merged as its own PR) calls the same
`POST /api/myrmidon/cto-chat/plan` and renders the proposal it gets; the two
halves meet only at the shared proposal contract in `@paperclipai/shared`.

The planner is off by default. It opens when both `MYRMIDON_CTO_CHAT_BASE_URL`
and `MYRMIDON_CTO_CHAT_KEY_SECRET` are set — see [../SETTINGS.md](../SETTINGS.md),
section "1.6 — CTO-CHAT B", for the full settings table.

## What the owner asks

The owner writes one free-text request — what is wanted, in plain words. Two
entries lead to the same planning step:

- the portal: the chat screen calls `POST /api/myrmidon/cto-chat/plan` with the
  message (one deliberate "build me an epic" action, a request/response call —
  not a stream on the chat socket);
- the owner's standing Telegram DM (the X8b bridge): the bridge resolves the
  turn and runs the same planner through the Telegram entry adapter described
  below.

The route body is `{ "text": "..." }` with the message between 1 and 20,000
characters; an optional `source` (`portal` / `telegram`) tags where the message
came from. The call is company-scoped: the chat screen passes `companyId` as a
query parameter, a caller that omits it is served from its own actor context
when that carries exactly one company.

The route CREATES NOTHING. It answers with a proposal and leaves every decision
— whether to show it, and which task to put the card on — to the caller.

## What the planner answers

A 200 answer is `{ proposal, payload }`:

- `proposal` — `{ planId, epic, epicClientKey, tasks[] }`: the epic (title,
  description, acceptance criteria) and one entry per child task (title,
  description, acceptance criteria, priority). `planId` is an opaque handle
  minted per request; nothing about a proposal is persisted, so the id exists
  only to correlate the answer with the request.
- `payload` — the ready `suggest_tasks` card payload for the approval card, so
  the caller does not have to map the proposal itself.

The plan is one completion from an OpenAI-compatible gateway
(`MYRMIDON_CTO_CHAT_BASE_URL`, model `MYRMIDON_CTO_CHAT_MODEL`, default
`dashscope-qwen-flash`), asked once — a failure is never retried, because a
retry would multiply a slow, paid call. The answer is validated against the
shared zod contract before anything else happens: a model that answers with
prose, JSON outside the contract, or a plan the card would reject is a stable
error, not a half-built card. JSON wrapped in a code fence is recovered; a
model answer that parses to nothing is rejected.

Limits, all enforced before or during the one completion: the message is at
most 20,000 characters; one proposal carries at most
`MYRMIDON_CTO_CHAT_MAX_TASKS` child tasks (default 8, hard ceiling 20); a task
carries at most 12 acceptance criteria of at most 500 characters each; titles
are at most 240 characters.

## The approval card

A proposal becomes a card the owner can accept — the board's existing
`suggest_tasks` card, not a new card type. The card hangs on the host task the
conversation already runs on: the standing Agent Chat conversation issue the
chat screen and the Telegram bridge share, so the card sits in the thread the
owner is already reading.

The card's title is `Proposed epic: <epic title>`; its summary is one line
("Proposed from your message: one epic with N task(s).") — the owner's original
message is not echoed. The task list is the epic first with no parent, every
child pointing at the epic; acceptance criteria are rendered into each task's
description under an "Acceptance criteria:" heading, so they stay visible on
the created task.

The card is idempotent by plan id: a retried call with the same `planId`
returns the card that already exists instead of stacking a second one, while a
re-planned message gets a fresh `planId` and a fresh card. Accepting,
rejecting, expiry and the creation transaction are the board's own card
semantics — unchanged by this feature.

## What acceptance does

Accepting the card creates the issues through the board's own `suggest_tasks`
acceptance path: one issue per draft, the epic as the parent of every child.
Before acceptance nothing exists — no issue, no draft rows; a rejected or
expired card creates nothing.

Two deliberate omissions:

- the card names no assignee. Who does the work is a staffing decision the
  lead makes, not something the planner may infer from prose;
- acceptance wakes the assignee of the host conversation task, so the outcome
  lands in the thread the owner answered in.

A child task may carry a priority from the proposal
(`critical` / `high` / `medium` / `low`); the epic's priority is left unset.

## Entering from Telegram

The same planning step is entered from the owner's standing Telegram DM
conversation (the X8b bridge). The server side is a thin adapter
(`planFromTelegramTurn`): the bridge resolves the turn — company, the standing
conversation task, the message text, the agent the card speaks as — and the
adapter runs the same planner and posts the same `suggest_tasks` card on the
same conversation task.

The card itself is never projected into Telegram as an interactive card: the
board's chat publication path externalizes questions and confirmations only.
The bridge answers the owner's message with a short reply instead:

- on success: the proposed epic's title, how many task(s) are proposed, and
  "Review and accept it on the task: <link>" (or "Review and accept it on the
  task in the board." when no link target is available);
- when the planner is not configured or the model key is not available to the
  company: "I cannot plan right now: <reason>.";
- when the message could not be planned: "I could not turn that into a plan:
  <reason>."

Failures come back as outcomes, not exceptions — a chat turn is not a place to
surface a stack trace, and the conversation stays alive. Accepting the card is
the ordinary board acceptance path, the same endpoint the portal card uses.

The Telegram entry adapter is exported from `server/src/myrmidon/cto-chat/`
for the bridge to call; wiring a live bridge turn to it is the bridge's own
step, and no second planning implementation or card type is needed for it.

## Failure codes

The route answers errors with a stable code and a message written for a
person; model output and keys never reach an error body.

| HTTP | Code | When |
|---|---|---|
| 503 | `planner_disabled` | `MYRMIDON_CTO_CHAT_BASE_URL` or `MYRMIDON_CTO_CHAT_KEY_SECRET` is unset (the message names the missing setting names, never values), or the named company secret is not available to the calling company |
| 400 | `empty_message` | The request text is empty after trimming |
| 400 | `message_too_long` | The request text is over 20,000 characters |
| 400 | `backend_unreachable` | The gateway could not be reached: network error or timeout (`MYRMIDON_CTO_CHAT_TIMEOUT_SEC`, default 90, raised to at least 5, capped at 600) |
| 400 | `backend_failed` | The gateway answered an error status or a body that is not JSON |
| 400 | `model_output_invalid` | The model answer does not parse into the plan contract |

## Operator notes

- The API key is a **company secret**, read by name (`MYRMIDON_CTO_CHAT_KEY_SECRET`)
  on every call and never stored in the settings, logs, errors or the journal.
  Rotating the key, changing the model or moving the address takes effect on
  the next message — no restart.
- The planner runs on the server, not in a bot container: the address, model
  and limits are instance settings; the key stays in the company's secret
  store (created in the "Secrets" section).
- The default model `dashscope-qwen-flash` is the free DashScope model; the
  1.6 wave rule keeps free models the default and paid models a deploy concern.
- A gateway address that already ends with `/v1` gets `/chat/completions`
  appended directly; otherwise `/v1/chat/completions` is appended.
- A value that is present but unusable (a non-numeric timeout or task limit)
  falls back to the default rather than disabling the path — an operator typo
  must not close a working feature. Only a missing address or key secret
  closes the planner.

## Related

- [../SETTINGS.md](../SETTINGS.md) — the `MYRMIDON_CTO_CHAT_*` variables
  (section "1.6 — CTO-CHAT B").
- [owner-telegram-cards.md](owner-telegram-cards.md) — how cards reach the
  owner's Telegram and which interaction kinds are delivered there.
- [ocr.md](ocr.md) — the OCR path, the other server-side consumer of an
  OpenAI-compatible gateway with a per-company key secret.
