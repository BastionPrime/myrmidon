# The Commander chat screen: free-text planning in the portal (CTO-CHAT A)

> Russian version: [commander-chat.ru.md](commander-chat.ru.md)

The Commander chat is the portal entry of the board chat planner: the owner
writes what is wanted in one free-text message, the board proposes an epic
with child tasks, and approving the proposal is what creates the tasks. The
server half of the flow — the planning route, the approval card, the
Telegram entry — is the planner guide, a sibling guide for the server half
(currently in review); this guide covers the screen itself: where it lives,
what the owner does on it, and what it shows while a proposal waits for a
decision.

The screen ships in the Myrmidon 2.0 interface tree and renders only when the
2.0 shell is on — the instance flag `enableMyrmidonUi2` or a browser's
`?ui=2` override (the shell has its own guide, currently in review).
It requires no configuration of its own; the screen is open as soon as the
planner is (`MYRMIDON_CTO_CHAT_BASE_URL` and `MYRMIDON_CTO_CHAT_KEY_SECRET`,
see [../SETTINGS.md](../SETTINGS.md) section "1.6 — CTO-CHAT B").

## Where the screen lives

The route is `commander-chat`, in the 2.0 route table behind the shell flag.
Three entries lead to it:

- the rail item "Commander" (group "Decide & talk") navigates to the screen;
- the phone bottom bar tab "Commander" navigates to the same route;
- the top bar's "Tell the Commander" field opens the commander palette
  (shortcut `Ctrl K`); submitting the palette navigates to the screen with
  the typed text carried over as the `draft` query parameter, so the request
  is not retyped.

The conversation partner is the company's Commander agent: the screen looks
for an agent whose role is `cto` or whose name matches "Commander". When the
company has none, the screen states "No Commander agent found in this company
yet." and nothing can be sent.

## What the owner does

The owner types the request into the composer (placeholder "Tell the
Commander what to build…") and presses the send button (label "Build a
plan"). The screen calls the planner route
`POST /api/myrmidon/companies/:companyId/cto-chat/plan` with the message —
one deliberate request, not a stream on the chat socket. While the planner
runs, the button shows a spinner and the composer is disabled.

While a proposal is pending, the screen also refreshes the standing
conversation's pending cards every 5 seconds (otherwise every 20 seconds),
so the approval card appears without a reload soon after the plan returns.

## What the screen shows

After a successful call, the proposed plan renders read-only above the
composer: the epic's title and description, then one card per task — the
epic itself labelled "Epic", every child task with its title, description
and acceptance criteria line by line. The draft text is cleared from the
composer after a successful send.

When a `suggest_tasks` approval card is pending on the standing Agent Chat
issue, the screen renders it through the board's existing card component,
with Accept and Reject calling the existing interaction endpoints. On a
decision the screen shows "Applying your decision…" and refreshes the
thread: accepting the card is what creates the issues (one issue per task,
the epic as the parent — see the planner guide, in review); rejecting
creates nothing.

A failed planning call renders an alert with the route's error message (a
person-worded message; the codes and the settings that close the planner are
in the planner guide, in review).

## The same flow from the owner's Telegram DM

The planning step is not portal-only: the owner's standing Telegram DM
conversation reaches the same planner and posts the same approval card on
the same conversation task, answering in the chat with the proposed epic's
title and a link to review and accept the card. The transport and the
wording of that reply are the Telegram section of the planner guide (in
review); from the card on, the flow is one: the same card, the same
acceptance path, the same created tasks.

## Related

- the planner guide (in review) — the server half: the planning route, the
  proposal contract, the approval card, the Telegram entry, the failure
  codes.
- the 2.0 shell guide (in review) — turning the shell on (the flag and the
  personal `?ui=` override).
- [../SETTINGS.md](../SETTINGS.md) — the `MYRMIDON_CTO_CHAT_*` variables
  (section "1.6 — CTO-CHAT B").
- [owner-telegram-cards.md](owner-telegram-cards.md) — how cards reach the
  owner's Telegram.
