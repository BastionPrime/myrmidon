// server/src/myrmidon/client-mail/channel.ts
//
// myrmidon(EXTCASE-M): the channel to the mail module on the client PC.
//
// The module lives inside the client's Windows connector service and the
// connection to it is outbound from the client (the connector channel of the
// case). This file is the board's *port* to that channel: one request, one
// answer, with the module's refusals mapped onto a result instead of an
// exception — a module that reports "Outlook is not running" is a fact the
// operator needs, not a broken board.
//
// Nothing here opens a socket. The transport belongs to the connector service
// part of the case (the outbound WSS + mTLS endpoint): when it lands, it
// implements `ClientMailChannel.send` and the whole mail path starts working
// without a change in this module. That is also what makes the pipeline
// testable on `main` today.
//
// Two rules are enforced here rather than trusted to the caller:
//
// - the request is validated by the shared contract before it leaves, so a
//   malformed action is refused locally instead of being sent to a Windows
//   service;
// - a response that is not a well-formed answer is a *reported* failure with a
//   stable reason, never a thrown value that would lose the mail item.

import {
  CLIENT_MAIL_MAX_ITEMS_PER_BATCH,
  clientMailModuleRequestSchema,
  clientMailModuleStatusSchema,
  clientMailBatchSchema,
  clientMailAttachmentPayloadSchema,
  type ClientMailModuleRequest,
  type ClientMailModuleStatus,
  type ClientMailBatch,
  type ClientMailAttachmentPayload,
} from "@paperclipai/shared";

/** Why a call to the module did not produce a usable answer. */
export type ClientMailChannelFailure =
  | { reason: "not_connected"; message: string }
  | { reason: "invalid_request"; message: string }
  | { reason: "invalid_response"; message: string }
  | { reason: "module_refused"; code: string; message: string }
  | { reason: "transport_failed"; message: string };

export type ClientMailChannelResult<T> = { ok: true; value: T } | ({ ok: false } & ClientMailChannelFailure);

/**
 * The transport. `send` carries one validated request to the module of one
 * company's client and returns whatever came back — the shape is not trusted
 * here, only in `parseModuleResponse`.
 */
export interface ClientMailChannel {
  send(input: { companyId: string; request: ClientMailModuleRequest }): Promise<unknown>;
}

/** Validates the outgoing request; the caller does not have to. */
export function prepareModuleRequest(raw: unknown): ClientMailChannelResult<ClientMailModuleRequest> {
  const parsed = clientMailModuleRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: "invalid_request",
      message: `the request is not a known mail action: ${issue?.path.join(".") || "shape"} — ${issue?.message ?? "invalid"}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** Reads one answer of the module: a refusal becomes a reported failure. */
export function parseModuleResponse<T>(
  raw: unknown,
  readResult: (payload: unknown) => T | null,
): ClientMailChannelResult<T> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "invalid_response", message: "the mail module answered with a value that is not an object" };
  }
  const answer = raw as { ok?: unknown; error?: unknown; message?: unknown; result?: unknown };
  if (answer.ok === false) {
    return {
      ok: false,
      reason: "module_refused",
      code: typeof answer.error === "string" ? answer.error : "unknown",
      message: typeof answer.message === "string" ? answer.message : "the mail module refused the request",
    };
  }
  const value = readResult(answer.result);
  if (value === null) {
    return { ok: false, reason: "invalid_response", message: "the mail module answered with an unusable result" };
  }
  return { ok: true, value };
}

/** One call, with the request validated and the answer read: the only way to reach the module. */
export async function callMailModule<T>(
  channel: ClientMailChannel,
  input: { companyId: string; request: unknown; readResult: (payload: unknown) => T | null },
): Promise<ClientMailChannelResult<T>> {
  const prepared = prepareModuleRequest(input.request);
  if (!prepared.ok) return prepared;
  let raw: unknown;
  try {
    raw = await channel.send({ companyId: input.companyId, request: prepared.value });
  } catch (error) {
    return {
      ok: false,
      reason: "transport_failed",
      message: error instanceof Error ? error.message : "the channel to the mail module failed",
    };
  }
  return parseModuleResponse(raw, input.readResult);
}

// ---------------------------------------------------------------------------
// The typed calls the pipeline and the routes make
// ---------------------------------------------------------------------------

function readStatus(result: unknown): ClientMailModuleStatus | null {
  const parsed = clientMailModuleStatusSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function readBatch(result: unknown): ClientMailBatch | null {
  const parsed = clientMailBatchSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/** The module's own report of the client's Outlook. */
export function mailModuleStatus(
  channel: ClientMailChannel,
  companyId: string,
): Promise<ClientMailChannelResult<ClientMailModuleStatus>> {
  return callMailModule(channel, {
    companyId,
    request: { action: "mail.status" },
    readResult: readStatus,
  });
}

/** The next batch of new mail since a watermark. */
export function listMail(
  channel: ClientMailChannel,
  companyId: string,
  input: { watermark?: string | null; limit?: number } = {},
): Promise<ClientMailChannelResult<ClientMailBatch>> {
  return callMailModule(channel, {
    companyId,
    request: {
      action: "mail.list",
      ...(input.watermark ? { watermark: input.watermark } : {}),
      limit: Math.min(input.limit ?? CLIENT_MAIL_MAX_ITEMS_PER_BATCH, CLIENT_MAIL_MAX_ITEMS_PER_BATCH),
    },
    readResult: readBatch,
  });
}

/** The bytes of one attachment. */
export function fetchMailAttachment(
  channel: ClientMailChannel,
  companyId: string,
  input: { messageId: string; attachmentId: string },
): Promise<ClientMailChannelResult<ClientMailAttachmentPayload>> {
  return callMailModule(channel, {
    companyId,
    request: { action: "mail.attachment.save", messageId: input.messageId, attachmentId: input.attachmentId },
    readResult: (result) => {
      const parsed = clientMailAttachmentPayloadSchema.safeParse(result);
      return parsed.success ? parsed.data : null;
    },
  });
}

/** Applies a decision: the message is moved into a folder or given categories. */
export function applyMailDecision(
  channel: ClientMailChannel,
  companyId: string,
  input: { messageId: string; decision: { kind: string; folderPath?: string | null; categories?: string[] | null } },
): Promise<ClientMailChannelResult<{ applied: true }>> {
  const request =
    input.decision.kind === "folder"
      ? { action: "mail.move" as const, messageId: input.messageId, folderPath: input.decision.folderPath ?? "" }
      : {
          action: "mail.categorize" as const,
          messageId: input.messageId,
          categories: input.decision.categories ?? [],
        };
  return callMailModule(channel, {
    companyId,
    request,
    // The module answers an applied decision with no payload of interest: the
    // caller only needs to know the call itself did not fail.
    readResult: () => ({ applied: true as const }),
  });
}