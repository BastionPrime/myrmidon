# Signing host contract (native messaging)

> Russian version: [signing-host-contract.ru.md](signing-host-contract.ru.md)

The extension signs documents through a helper process on the client PC. The
two sides talk over Chrome Native Messaging, and the message contract is
`extension/src/native-host-contract.ts` — types and validators only, no
implementation. A concrete helper (token middleware binding, PIN storage) is
deployment-specific and lives outside the public fork; both sides compile
against this contract.

## Transport and trust boundary

The wire format is Chrome Native Messaging: each message is a UTF-8 JSON
object prefixed with a 4-byte little-endian length, exchanged over the stdio
pipe the browser opens for the host. The browser only launches hosts whose
manifest `allowed_origins` matches the extension ID, so that registration is
the single trust boundary; hosts have no network interfaces.

Only the command and the result cross the extension ↔ host boundary. Secrets
such as PINs or private keys must never appear in either direction, and the
helper never persists the document.

## Request

`SignRequestMessage` — the only inbound message type:

| Field | Type | Notes |
|---|---|---|
| `type` | `"sign"` | constant |
| `id` | `number` | finite; echoed back in the response |
| `actionType` | `SignActionType` | closed enum, see below |
| `documentRef` | `string` | non-empty workspace reference |
| `document` | `DocumentPayload` | bytes or digest, see below |

`actionType` is a closed enum (`SIGN_ACTION_TYPES`) — unknown values are
rejected:

- `sign`
- `sign_and_submit`
- `sign_attachment`

`document` (`DocumentPayload`) is exactly one of:

- `{ kind: "bytes", bytesBase64: string }` — raw document bytes, base64;
  `bytesBase64` must be a non-empty string. The extension downloads/reads the
  document itself.
- `{ kind: "digest", digestHex: string }` — a pre-computed SHA-256 of the
  document; `digestHex` must match `^[0-9a-f]{64}$` (case-insensitive).

## Response

`SignResponseMessage`: `type` is `"sign_result"`, `id` echoes the request id,
`result` is a `SignResult`:

- success — `{ ok: true, hash }`, where `hash` is the hex digest of the signed
  document (what the action journal records);
- failure — `{ ok: false, error, message? }`, where `error` is a
  `SignErrorCode` and `message` is optional free text.

Error codes are a closed set (`SIGN_ERROR_CODES`):

| Code | Meaning |
|---|---|
| `invalid_request` | the request failed validation |
| `unknown_action_type` | `actionType` outside the enum |
| `unsupported_payload` | the helper cannot take this payload form |
| `pin_unavailable` | the PIN is not available on this PC |
| `middleware_error` | the token middleware failed |
| `cancelled` | the person cancelled the step |

## Validation

The contract exports three validators, covered by
`extension/tests/native-host-contract.spec.ts`:

- `isSignActionType` — enum membership;
- `isDocumentPayload` — payload shape (non-empty base64 for `bytes`, SHA-256
  hex for `digest`);
- `isSignRequestMessage` — full request validation.

A message that fails full validation is either dropped (no usable request id)
or answered with an explicit `invalid_request` failure — it never reaches any
signing logic.

## Related

- [bridge-extension.md](bridge-extension.md) — the extension itself.
- [browser-bridge-gateway.md](browser-bridge-gateway.md) — the board side and
  the signing policy (`general.browserBridge.signing`).
