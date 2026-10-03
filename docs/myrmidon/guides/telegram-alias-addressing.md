# Telegram bridged chat: addressing any company agent with @<alias>

> Русская версия: [telegram-alias-addressing.ru.md](telegram-alias-addressing.ru.md)

One bridged Telegram chat (a bot DM connected with
`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`, or a group topic where the bot was
mentioned) can reach **any agent of the company**, not only the agent
assigned to the endpoint: start (or mention) an alias, and the message
routes to that agent's own standing conversation, with the reply posted
back into the same Telegram chat.

```
@gip recheck the estimate for section 3
```

No setting enables this: it rides the X8b bridge. When the variable is
unset, the vendor path is unchanged and nothing in this guide applies.

## Where the message goes

- A message whose leading `@<alias>` (or any `@`-token in the text)
  resolves to an agent of the company routes into **that agent's own**
  standing Agent Chat conversation with the same Telegram identity —
  `conversation_agent_id` is the addressed agent, while
  `conversation_user_id` stays `telegram:<board user id>`. The switch is
  per agent: a DM (or topic) that addressed one agent later addresses
  another one, and going back restores the earlier conversation — the
  history of each conversation is preserved in its own issue.
- The addressed agent's reply is published **into the same Telegram
  thread** the message came from, prefixed with the agent's display name:
  `[GIS] here is the revised estimate…`.
- The first turn of an addressed agent quotes the recent messages of that
  Telegram chat, so the agent joins the conversation with context. The
  quote depth is governed by the cross-channel settings
  (`MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES` and siblings).
- The leading `@<alias>` token is removed from the turn's body — it has
  already routed the message. A mention in mid-sentence is left as
  ordinary text; only the leading token routes.
- A message with no resolvable `@`-token goes to the endpoint's assigned
  agent exactly as before the change.

## What an alias is and where it lives

An alias is a short handle the operator picks per agent. Aliases live in
the agent card JSON — the `telegramAliases` string array in
`agents.metadata` (or `agents.adapter_config`):

```json
{ "telegramAliases": ["gip", "estimator"] }
```

Matching when resolving a mention, in priority order:

1. exact alias (case-insensitive; the longest alias wins when one alias is
   a prefix of another, so `@gip2` does not resolve as `@gip`),
2. the agent's name,
3. the agent's title.

Only agents of the **same company** as the endpoint are addressable — an
alias of another company's agent never resolves.

## Who may address an agent

Addressing follows the X8b identity gate: it applies only when the
Telegram sender resolves to a linked board user of the instance. An
unlinked sender is answered by the bridge's refusal path before any
resolution runs. In group topics, a message resolves an addressee only
when it addressed the bot — the vendor's `requireMention` gate drops the
rest.

## Commands (part B, in review at the time of writing)

The chat-side management commands below follow the stable part B
contract; if part B's merge names a command differently, this row will be
corrected in a follow-up patch.

| Command | What it does |
|---|---|
| `/agents` | Lists the company's agents with their aliases |
| `/to <alias>` | Switches the chat's default addressee until the next `/to`; `/to` with no argument resets it |
| `/who` | Shows the current default addressee |

An unknown alias in `/to` answers with the list of valid ones.

## Where the records live

The addressing itself needs no new settings rows; the behavior and its
relation to the vendor code are recorded in
[DIVERGENCE.md](../DIVERGENCE.md) (X9a, X9b), and the underlying bridge
settings in [SETTINGS.md](../SETTINGS.md) (`MYRMIDON_TELEGRAM_DM_CONVERSATIONS`).
