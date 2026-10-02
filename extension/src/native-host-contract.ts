// Generic native-messaging host contract for signing helpers.
//
// Wire format is Chrome Native Messaging: each message is a UTF-8 JSON object
// prefixed with a 4-byte little-endian length, exchanged over the stdio pipe
// the browser opens for the host. The browser only launches hosts whose
// manifest allowed_origins matches the extension ID, so this registration is
// the single trust boundary; hosts have no network interfaces.
//
// This file is the contract only: types and validators, no implementation,
// no client specifics. Concrete signing helpers (which bind a token
// middleware and a PIN store) live outside the public fork. Only the command
// and the result cross the extension <-> host boundary; secrets such as PINs
// or private keys must never appear in either direction.

/** Allowed sign operations. Closed enum: unknown values are rejected. */
export const SIGN_ACTION_TYPES = ["sign", "sign_and_submit", "sign_attachment"] as const;

export type SignActionType = (typeof SIGN_ACTION_TYPES)[number];

export function isSignActionType(value: unknown): value is SignActionType {
  return typeof value === "string" && (SIGN_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Document bytes or a digest of them. The helper never persists the document:
 * the extension downloads/reads the document and passes either raw bytes or a
 * pre-computed hash.
 */
export type DocumentPayload =
  | { kind: "bytes"; bytesBase64: string }
  | { kind: "digest"; digestHex: string };

/** Command from the extension to the host. documentRef is a workspace ref. */
export interface SignRequestMessage {
  type: "sign";
  id: number;
  actionType: SignActionType;
  documentRef: string;
  document: DocumentPayload;
}

export interface SignSuccess {
  ok: true;
  /** Hex digest of the signed document (what the action journal records). */
  hash: string;
}

export interface SignFailure {
  ok: false;
  error: SignErrorCode;
  message?: string;
}

export const SIGN_ERROR_CODES = [
  "invalid_request",
  "unknown_action_type",
  "unsupported_payload",
  "pin_unavailable",
  "middleware_error",
  "cancelled",
] as const;

export type SignErrorCode = (typeof SIGN_ERROR_CODES)[number];

export type SignResult = SignSuccess | SignFailure;

export interface SignResponseMessage {
  type: "sign_result";
  id: number;
  result: SignResult;
}

export type InboundMessage = SignRequestMessage;

export function isDocumentPayload(value: unknown): value is DocumentPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "bytes") return typeof v.bytesBase64 === "string" && v.bytesBase64.length > 0;
  if (v.kind === "digest") return typeof v.digestHex === "string" && /^[0-9a-f]{64}$/i.test(v.digestHex);
  return false;
}

/**
 * Full request validation. Messages that fail here are either dropped (no
 * usable request id) or answered with an explicit invalid_request failure —
 * they never reach any signing logic.
 */
export function isSignRequestMessage(value: unknown): value is SignRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "sign" &&
    typeof v.id === "number" &&
    Number.isFinite(v.id) &&
    isSignActionType(v.actionType) &&
    typeof v.documentRef === "string" &&
    v.documentRef.length > 0 &&
    isDocumentPayload(v.document)
  );
}
