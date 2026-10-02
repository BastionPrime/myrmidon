# Connector panel: pairing, signing policy and the journal

> Russian version: [connector-panel.ru.md](connector-panel.ru.md)

The connector panel (**Company settings → Connectors**) is the operator's
control surface for client devices that connect through the
[browser bridge](browser-bridge-gateway.md). From it you pair and revoke
devices, keep the domain allowlist, set the signing policy with its
safeguards, and read the journal of what the bridge did.

## Devices

The device list shows every paired device of the company: online/offline
status, last activity, extension version and the capabilities the device
declared at handshake.

**Pair a device.** Press *Issue pairing code*, optionally with a label. The
panel shows the one-shot code **once**, right after issue, with its expiry —
the code lives 15 minutes, and a new issue clears the previous display. Read
the code to the person at the client PC; they enter it in the extension popup
(see [bridge-extension.md](bridge-extension.md)).

**Revoke a device.** *Revoke* asks for a typed confirmation, then deletes the
device record fail-closed: the token stops validating and a live connection
drops at once.

## Domain allowlist

One hostname per line. Only these domains (and their subdomains) may be opened
by the bot; everything else is refused by the gateway — and by the extension
itself before any browser API is touched. A line that is not a bare hostname is
dropped, not guessed at.

## Signing policy

- **Mode** — *Automatic* (the client-side helper signs at once), *Manual
  confirmation* (a person confirms every signature on the client PC), or *Per
  action type* (only the listed action types need a person).
- **Daily limit** — how many signatures the gateway accepts per UTC day;
  empty means no limit. The panel shows today's counter next to the limit. When
  the limit is reached the action is refused before anything is sent to the
  device, with the reason journaled.
- **Emergency stop** — one button turns signing off whatever the mode
  (`signing.enabled: false`); after it the gateway rejects every sign action
  fail-closed and the fact lands in the journal. The button is disabled while
  signing is already off.

Panel writes (`PATCH /api/myrmidon/browser-bridge/settings`, the emergency
stop) require the **instance admin** role. A board member of the company reads
the device list, the allowlist and the journal.

## Journal

The journal view lists the bridge rows of the company — actions and
signatures — with filters by device, method, outcome, a *signatures only*
toggle and a time range. A signature row carries the hash of the signed
document. Page content is never journaled: rows hold sizes and workspace
references, not text or images. The view returns at most 200 rows per request
(50 by default); the "signed today" counter follows the UTC day.

## Related

- [browser-bridge-gateway.md](browser-bridge-gateway.md) — routes, the wire
  contract, pairing internals, error codes.
- [bridge-extension.md](bridge-extension.md) — the extension on the client PC.
