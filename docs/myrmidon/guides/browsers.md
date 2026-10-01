# Browsers: live screen console

> Русская версия: [browsers.ru.md](browsers.ru.md)

Browsers is a settings section (Settings → Browsers, route
`company/settings/browsers`, the last entry of the settings tab bar) that lets
the owner watch and drive the live browsers bots sign in through: open a screen
session, keep it alive, close it, clear a site's data and read the session
journal. While a screen session is open, bots do not drive that browser.

The screen node itself (x11vnc + websockify over the live browser) is a
separate deployment; the board holds the registry, the session timers, the bot
pause and the journal, and talks to the node through a small HTTP API. The
noVNC screen view inside the panel arrives with the screen node (part B of the
feature); the section already runs the full session lifecycle.

## Availability

The section reads the registry from `MYRMIDON_BROWSER_FLEET` on every request —
an operator edits the variable and the next page load shows the new list, no
restart is needed beyond applying the environment. With the variable unset the
page shows "No browsers are configured on this instance." An invalid value
(broken JSON, not an array, a bad or duplicate id, too many entries or egress
keys) reads as an empty registry with a warning in the server log — the page
answers with an empty list, not an error.

Screen sessions additionally need the screen node address and token
(`MYRMIDON_BROWSER_CONSOLE_HOST`, `MYRMIDON_BROWSER_CONSOLE_TOKEN`). Without
them "Open screen" fails with "The screen node did not answer" (HTTP 502).

## Who can do what

- Any authenticated board user reads the registry (the list of browsers and
  who is using them). Agents may read the registry too.
- Only the owner — a board user with an active owner role in the company, an
  instance admin, or the local implicit actor — opens and closes screen
  sessions, clears site data and reads the journal. Agents get 403 on all of
  these.
- Heartbeat and Done are accepted only from the owner who opened the session;
  another owner gets 403 while the session is open.

## The browser list

Each configured browser is a card with its display name, id and egress route
labels, taken from `MYRMIDON_BROWSER_FLEET` (a JSON array:

```json
[{"id":"browser-a","displayName":"Live browser A","egress":{"ru":"socks ru1","ig":"socks nd1"}}]
```

Ids are lowercase slugs; at most 16 browsers and at most 8 egress keys per
browser. While a screen session is open on a browser the card shows "In use by
<user id>"; the list refreshes itself every 15 seconds.

## Opening a screen session

Press **Open screen** on a browser card. The board calls the screen node, asks
it to pause the bots on that browser, and records the session. If a session is
already open on that browser the call answers 409; if the node does not answer
or cannot pause the bots, the call answers 502 and nothing stays half-open.

While the session is open the card gains the screen panel with:

- the auto-close countdown ("Auto-close in …"), driven by two timers — the idle
  timeout (`MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN`, default 30 minutes without
  reported activity) and the hard ceiling
  (`MYRMIDON_BROWSER_MAX_DURATION_MIN`, default 120 minutes regardless of
  activity). The session closes at whichever deadline comes first;
- the auto-close warning during the last 60 seconds before the deadline;
- the **Report activity** button, which resets the idle timer (the screen view
  of part B reports mouse and key activity the same way; a bare keep-alive
  heartbeat every 30 seconds does not reset it);
- the **Done** button, which closes the session and resumes the bots.

A session survives a page reload and is shared between tabs: reopening the page
adopts the open session. Closing works from any of the owner's tabs, but a
session opened by another owner answers 403 to heartbeat and Done.

## Bot pause while the screen is open

Two independent contours keep bots off the browser during a session:

1. The screen node contract: the node receives a `pause` call for the browser
   when the session opens and a `resume` call when it closes, however it
   closes — Done, idle timeout, or the hard ceiling.
2. The server-side MCP guard: the board registers a guard that rejects MCP
   tool calls aimed at that browser with HTTP 423 ("An owner screen session is
   open on this browser; MCP calls are paused") while the session is live. The
   guard holds even if a node call is lost. In this part of the feature the
   guard is registered and tested; the tool gateway starts consulting it at its
   browser-tool call points with part B.

## Closing and the journal

A session ends in one of three ways, all recorded in the journal:

| Closed by | Meaning |
|---|---|
| `done` | The owner pressed Done |
| `idle_timeout` | No activity for the idle timeout |
| `max_duration` | The hard ceiling hit, even with constant activity |

The journal (the Session journal section under the list) keeps the last 50
sessions across all browsers: browser id, who opened it, start time, duration
and the close reason. Sessions and the journal live in
`instance_settings.general.myrmidonBrowserConsole` — no database migration is
involved, and the key survives vendor writes of the general settings.

## Clearing site data

Each card has a Clear site data form: type a bare domain (`example.com`, never
a URL) and confirm. The node clears that domain's cookies and storage in the
live browser via CDP. The form refuses to run while a screen session is open on
that browser (409) — close the screen first. An unreachable node answers 502.

## API surface

Base path `/api/myrmidon/browsers`; all calls except the registry list take
`companyId` as a query parameter:

```text
GET    /api/myrmidon/browsers                      — registry + live session state
POST   /api/myrmidon/browsers/:id/screen/open      — open a session (owner)
POST   /api/myrmidon/browsers/:id/screen/heartbeat — keep alive / report activity (session owner)
POST   /api/myrmidon/browsers/:id/screen/done      — close the session (session owner)
DELETE /api/myrmidon/browsers/:id/data             — clear site data, body {"domain":"example.com"} (owner)
GET    /api/myrmidon/browsers/journal              — last 50 sessions (owner)
```

## Settings

All five variables are documented in [../SETTINGS.md](../SETTINGS.md), section
"1.4 — live browser screen (BROWSER-CONSOLE)": `MYRMIDON_BROWSER_FLEET`,
`MYRMIDON_BROWSER_CONSOLE_HOST`, `MYRMIDON_BROWSER_CONSOLE_TOKEN`,
`MYRMIDON_BROWSER_IDLE_TIMEOUT_MIN`, `MYRMIDON_BROWSER_MAX_DURATION_MIN`.

## Operator notes

- The board row is BROWSER-CONSOLE in [../DIVERGENCE.md](../DIVERGENCE.md); the
  module is `server/src/myrmidon/browser-console/`, the UI is
  `ui/src/components/myrmidon/browsers/`, the route is mounted in
  `server/src/app.ts` and `ui/src/App.tsx`.
- The host and token values are never logged.
- Clearing site data is irreversible for that domain's cookies and storage in
  the live browser — sign-ins on that site are lost.
