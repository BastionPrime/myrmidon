// server/src/myrmidon/ocr/contracts.ts
//
// myrmidon(EXT-CASE-OCR): the two producers of a PDF, adapted to one input.
//
// The mail connector fetches an attachment (`fetchAttachment` of the MailSource
// contract) and the browser bridge downloads a file on the client's machine
// (`browser.download`). Both end up as file name plus bytes, and neither module
// needs to know about the other: the adapters below are the only place where a
// producer's field names appear. Until those modules land, their shape is a
// mock — the two interfaces are the contract, and both carry only fields the
// OCR path actually writes down (name, bytes, an optional source id).

import type { OcrDocumentInput } from "./types.js";

/** What `mail.attachment` / `MailSource.fetchAttachment` hands over. */
export interface MailAttachmentLike {
  /** File name of the attachment. */
  name: string;
  /** Attachment bytes; the connector already downloaded them. */
  bytes: Uint8Array;
  /** Id of the message the attachment came from, when the connector knows it. */
  messageId?: string | null;
}

/** What `browser.download` hands over. */
export interface BrowserDownloadLike {
  /** File name of the download. */
  name: string;
  /** File bytes. */
  bytes: Uint8Array;
  /** The page the file came from, when the bridge knows it. */
  url?: string | null;
}

/** A mail attachment as an OCR input. */
export function ocrInputFromMailAttachment(attachment: MailAttachmentLike): OcrDocumentInput {
  return {
    name: attachment.name,
    bytes: attachment.bytes,
    origin: "mail_attachment",
    sourceId: attachment.messageId ?? null,
  };
}

/** A browser download as an OCR input. */
export function ocrInputFromBrowserDownload(download: BrowserDownloadLike): OcrDocumentInput {
  return {
    name: download.name,
    bytes: download.bytes,
    origin: "browser_download",
    sourceId: download.url ?? null,
  };
}