# Browser bridge extension (part C)

> Russian version: [bridge-extension.ru.md](bridge-extension.ru.md)

The browser bridge gives a company bot read-only eyes and hands in a browser on
a client PC: open, read, click, screenshot. The bridge has two sides. The
gateway side (part B) lives on the board; the extension side (part C) is the
Chrome/Edge extension in [`extension/`](../../../extension/). Part D adds
fill/download and human-confirmed signing steps and is not merged yet.

## What the extension is

A Manifest V3 extension (`extension/manifest.json`), a standalone npm package
outside the pnpm workspace (`@myrmidon/extension`, private). It opens exactly
one outbound connection — a WSS client to the bridge gateway — and no inbound
port. Permissions are minimal: `storage`, `tabs`, and `wss://*/*` host access.
Everything the extension executes ships in this repository; there is no remote
code.

The wire contract is JSON-RPC 2.0, mirrored from the gateway into
`extension/src/protocol.ts` (the original,
`packages/shared/src/myrmidon-browser-bridge.ts`, arrives with part B — not
merged yet; when the gateway contract changes, both files change in sync). The
handshake is `bridge.hello` →
`bridge.ready`; the gateway announces the protocol revision and the company's
allowlist of tender-site domains in `bridge.ready`.

## Actions

This build implements four read-only methods: `browser.open`, `browser.read`,
`browser.click`, `browser.screenshot` (`extension/src/actions.ts`,
`EXTENSION_CAPABILITIES`). `browser.fill` and `browser.download` exist in the
protocol but are refused by this build — the capability check runs in the
gateway and again locally in the extension, deny by default.

Every action passes a local allowlist gate (`extension/src/allowlist.ts`)
before any browser API is touched: the extension keeps its own copy of the
company's domain allowlist and matches the target host as the domain itself or
its subdomain. The gateway checks again — defense in depth.

## Pairing

1. The company operator creates a one-shot pairing code in the bridge panel
   (15-minute lifetime) and reads it to the person at the client PC.
2. The person opens the extension popup, enters the gateway address and the
   code, and presses Pair. Codes normalize as typed: trimmed, uppercased, dash
   optional (`ABCD-2345`).
3. The extension exchanges the code for a bridge token
   (`POST /bridge/v1/pair`, `extension/src/pairing.ts`) and stores it in
   `chrome.storage.local`, bound to a device id generated on that PC.
4. The popup's Connect button opens the outbound WSS connection
   (`/bridge/v1?token=…`); the handshake is `bridge.hello` → `bridge.ready`.

Unpair removes the token. Revoking the device in the bridge panel makes the
gateway refuse the token (fail-closed) and the connection drops. The bridge
token never appears in the UI, in logs, or in the page.

## Signing

The extension signs documents through a local helper process on the client PC,
talked to over Chrome Native Messaging. The message contract —
`extension/src/native-host-contract.ts` (types and validators only; a concrete
helper lives outside the public fork) — is documented in
[signing-host-contract.md](signing-host-contract.md).

## Build and install

```sh
cd extension
npm install
node build.mjs        # or: npm run build
```

The build (`extension/build.mjs`) runs `tsc` and copies the manifest into
`dist-extension/` — the load-unpacked directory. In Chrome or Edge open
`chrome://extensions`, enable Developer mode, and choose "Load unpacked"
pointing at `dist-extension/`. Type-checking without output:
`npm run typecheck` (`tsc --noEmit`). Requires Node >= 24.11.

The extension is not part of the board image and is not deployed with it: it is
installed manually on each client PC.

## Tests

```sh
cd extension
npm test
```

Vitest with jsdom and injected ports (`extension/tests/`): no real Chrome, no
real network. Fixtures use `example.com` and neutral pairing codes.
