# Browser bridge: the client connector gateway and pairing

> Russian version: [browser-bridge-gateway.ru.md](browser-bridge-gateway.ru.md)

The browser bridge lets a company bot act in a browser on a client PC: open
pages, read, click, fill, download, screenshot, and — under an operator-set
policy — take part in a signing step that a person completes on that PC. The
client PC has no open port: the browser extension dials **out** to the board,
and the board accepts the connection. This guide covers the board side (the
gateway) and the pairing. The extension side is
[bridge-extension.md](bridge-extension.md); the operator panel is
[connector-panel.md](connector-panel.md).

The gateway is the fork module `server/src/myrmidon/browser-bridge/`; the wire
contract is `packages/shared/src/myrmidon-browser-bridge.ts`, mirrored into the
extension (`extension/src/protocol.ts`) — a contract change touches both.

## Why outbound

The board cannot drive a browser of its own on the client PC: the signing key
is local to that PC and never leaves it. So the transport is inverted — the
extension opens exactly one outbound WebSocket connection to the board, and the
board calls browser actions down that connection. One audit row per action
lands in the company's activity log.

## Connections and routes

| Endpoint | Who calls it | Auth |
|---|---|---|
| `WS /bridge/v1?token=…` | the extension | device bridge token |
| `POST /bridge/v1/pair` | the extension, once | the one-shot pairing code, nothing else |
| `POST /api/myrmidon/browser-bridge/companies/:companyId/pairing-codes` | panel | board member of the company |
| `GET /api/myrmidon/browser-bridge/companies/:companyId/devices` | panel | board member of the company |
| `DELETE /api/myrmidon/browser-bridge/companies/:companyId/devices/:deviceId` | panel | board member of the company |
| `GET /api/myrmidon/browser-bridge/companies/:companyId/journal` | panel | board member of the company |
| `GET /api/myrmidon/browser-bridge/settings` | panel | board |
| `PATCH /api/myrmidon/browser-bridge/settings` | panel | instance admin |
| `POST /api/myrmidon/browser-bridge/signing/disable` | panel / operator script | instance admin |

(`server/src/myrmidon/browser-bridge/routes.ts`; the journal read route comes
with the panel.) The settings record lives in
`instance_settings.general.browserBridge` — instance-wide, like `runLimits`.

## The wire

JSON-RPC 2.0 over the WebSocket. The gateway authenticates the token **before**
the HTTP upgrade and requires `bridge.hello` as the first frame:

- `bridge.hello` carries `{deviceId, extVersion, capabilities}`.
- The gateway answers `bridge.ready`: the protocol revision
  (`BRIDGE_PROTOCOL_VERSION = 1`), the **granted** capabilities — the
  intersection of what the extension declared and what the gateway knows — and
  the company's domain allowlist.
- `browser.cancel` is a one-way notification the gateway sends when it gives up
  on a request (the budget expired, most often a signing step the person did
  not confirm); the extension drops the pending action and the gateway journals
  a timeout.

An action runs on a 30-second budget (`BRIDGE_ACTION_TIMEOUT_MS`); a step that
needs a human gets 180 seconds (`BRIDGE_CONFIRMATION_TIMEOUT_MS`).

## Methods and capabilities

Methods: `browser.open`, `browser.read`, `browser.click`, `browser.fill`,
`browser.download`, `browser.screenshot`, `browser.sign`. Each maps to the
capability key of the same name (`open`, `read`, …). The capability gate is
deny by default: a bot request whose capability was not granted at handshake is
refused with `capabilityUnsupported`. The extension checks its own set again
locally — defense in depth.

## Pairing

1. An operator issues a **one-shot pairing code** from the panel
   (`POST …/pairing-codes`, optional `label`). The code is 8 characters from an
   alphabet without look-alikes (no `0`/`O`/`1`/`I`/`L`), shown as
   `XXXX-XXXX`, and lives **15 minutes** (`PAIRING_CODE_TTL_MS`). Pending codes
   are kept in process memory — a board restart drops them; issue a new one.
2. On the client PC, the person enters the gateway address and the code in the
   extension popup. Codes normalize as typed: trimmed, uppercased, the dash
   optional (`normalizePairingCode`).
3. The extension exchanges the code for a long-lived **bridge token**
   (`POST /bridge/v1/pair` with `{code, deviceId, extVersion, capabilities?}`).
   The token is an opaque 256-bit value with the prefix `mbb_`; only its HMAC
   digest is stored, peppered by `MYRMIDON_BROWSER_BRIDGE_PEPPER` (see
   [../SETTINGS.md](../SETTINGS.md)).
4. The device record is a **company secret** `browser_bridge.device.<deviceId>`:
   the secret value is the token, the metadata is the device record. The token
   never appears in the UI, in logs, or in the page.
5. The extension connects (`WS /bridge/v1?token=…`) and speaks the handshake
   above.

A spent or expired code is refused (`pairingCodeInvalid` /
`pairingCodeExpired`) and the refusal is journaled. **Revoking** a device
(`DELETE …/devices/:deviceId`) is fail-closed: the record is deleted and the
live socket is dropped by the same call.

## Domain allowlist

`general.browserBridge.domains` — bare hostnames, one per entry (lowercase, no
scheme, port, path or wildcard; an entry that is not a bare hostname is dropped
rather than guessed at, so a typo cannot widen the list). A host matches when
it is the domain itself or a subdomain: `tender.example` covers
`www.tender.example` but never `tender.example.evil.test` — the boundary is the
dot (`hostMatchesAllowlistDomain`). Only `http:`/`https:` pages are eligible,
and an empty allowlist refuses everything. The gateway checks every URL;
the extension keeps its own copy and checks before touching any browser API.

## Signing policy

`general.browserBridge.signing`:

- `enabled` — the emergency switch: when off, **every** sign action is refused
  whatever the mode (`signingDisabled`). The one-call switch is
  `POST /api/myrmidon/browser-bridge/signing/disable`; it writes the fact to
  the company journal.
- `mode` — `auto` (the local helper signs at once), `manual` (a person confirms
  every signature on the client PC), or `types` (only the action types listed
  in `types` need a person; the rest sign automatically).
- `dailyLimit` — a ceiling on journaled `browser.sign` executions per company
  per **UTC day**; `0` means no limit (default). The gateway checks the counter
  in `runAction` **before** sending anything to the device; a refusal returns
  the error code `dailyLimitReached` and is journaled. Schema ceiling:
  10 000.

The signature itself never crosses the board: the extension talks to a local
helper over native messaging, the helper drives the token middleware, and the
private key and PIN stay on the client PC. What returns is a status
(`signed` / `refused`) and the SHA-256 of the signed document — the journal row
carries the hash, never the bytes.

## The journal

One row per action in the company's activity log: who asked, when, the method,
the outcome, the confirmation status, and for signatures the document hash.
**Page content never enters the journal** — only sizes and workspace
references (a screenshot lives in the workspace, the journal holds the
reference). The panel reads the journal through
`GET …/companies/:companyId/journal` with filters `deviceId`, `method`,
`outcome`, `signaturesOnly`, `from`, `to`, `limit` (default 50, at most 200
rows) and, when a daily limit is set, the counter of signatures executed today
(UTC) next to the limit.

Error codes are stable JSON-RPC codes: standard `-32700…-32603` plus bridge
codes `-32010 notPaired`, `-32011 revoked`, `-32012 capabilityUnsupported`,
`-32013 domainNotAllowed`, `-32014 deviceOffline`, `-32015 timeout`,
`-32016 pairingCodeInvalid`, `-32017 pairingCodeExpired`,
`-32018 protocolVersionUnsupported`, `-32019 confirmationNotGranted`,
`-32020 signingDisabled`, `-32021 dailyLimitReached`
(`BROWSER_BRIDGE_ERROR_CODES` in the contract).

## Settings summary

- `MYRMIDON_BROWSER_BRIDGE_PEPPER` — HMAC pepper for pairing codes and bridge
  tokens. Unset: the process takes a random pepper per start and logs a
  warning, and every device pairs again after a restart. Per-instance, kept in
  the board environment, never in the panel-edited settings. Details:
  [../SETTINGS.md](../SETTINGS.md).
- Everything else lives in `instance_settings.general.browserBridge`
  (`domains`, `signing`), edited from the panel.

## Related

- [bridge-extension.md](bridge-extension.md) — the extension: install,
  build, pairing from the client PC side.
- [connector-panel.md](connector-panel.md) — the operator panel walkthrough.
- [../SETTINGS.md](../SETTINGS.md) — `MYRMIDON_BROWSER_BRIDGE_PEPPER`.
