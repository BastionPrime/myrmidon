# Myrmidon Bridge — browser extension (part C)

Chrome/Edge extension (Manifest V3) that lives on the client PC and gives the
company bot read-only eyes and hands in the browser: open, read, click,
screenshot. Part D adds fill/download and human-confirmed signing steps.

## Shape

```
extension/
  manifest.json          MV3 manifest: storage, tabs, content script
  src/
    protocol.ts          wire contract mirrored from the gateway (part B)
    allowlist.ts         the local allowlist gate
    state.ts             settings + chrome.storage.local (device id, token)
    jsonrpc.ts           JSON-RPC 2.0 framing
    pairing.ts           pairing-code client (code -> bridge token)
    actions.ts           read-only browser actions
    gateway-client.ts    outbound WSS connection + bridge.hello/ready handshake
    entry-background.ts  the MV3 service worker
    entry-content.ts     isolated-world content script (read/click only)
    entry-popup.ts       pairing UI
    entry-options.ts     options page
  popup/ options/        static HTML of the popup and options page
  build.mjs              tsc compile + manifest copy -> dist-extension/
  tests/                 vitest suites (jsdom + mocks, no real Chrome)
```

## Build

```
cd extension
npm install
node build.mjs          # or: npm run build:tsc
```

`dist-extension/` is the load-unpacked directory. `tsc --noEmit`
(`npm run typecheck`) type-checks without writing anything.

## Pairing

1. The company operator creates a one-shot pairing code in the bridge panel
   (15-minute lifetime) and reads it to the person at the client PC.
2. The person opens the extension popup, enters the gateway address and the
   code, and presses Pair.
3. The extension exchanges the code for a bridge token and stores it in
   `chrome.storage.local`, bound to a device id generated on this PC.
4. The popup's Connect button opens the outbound WSS connection; the
   handshake is `bridge.hello` -> `bridge.ready`.

Unpair removes the token. Revoking the device in the bridge panel makes the
gateway refuse the token (fail-closed) and the connection drops.

## Security notes

- Outbound WSS only; the extension opens no port.
- Permissions are minimal: `storage`, `tabs`, `wss://*/*`. No remote code:
  everything the extension executes is in this repository.
- The extension trusts only the gateway address the operator entered
  (origin-pinning); the tender-site page cannot command the extension — the
  content script runs in an isolated world and answers two read-only
  operations only.
- Every action is checked against the company's allowlist of tender-site
  domains before anything is sent, and the gateway checks again.
- The bridge token never appears in the UI, in logs, or in the page; it
  travels only as the WSS query parameter that the gateway's transport
  defined.

## Tests

```
cd extension
npm test
```

Vitest with jsdom and injected ports: no real Chrome, no real network.
Fixtures use `example.com` and neutral pairing codes.
