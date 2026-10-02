// The download primitive's page side (part D).
//
// The file is fetched in the content script, which runs in the page's origin:
// the request therefore carries the session cookies the person's browser
// already holds for the platform, exactly as a click on the document link
// would. The extension's own `fetch` would be cross-origin from the service
// worker and would not have that session.
//
// The bytes come back base64-encoded so a single JSON frame carries them; the
// ceiling is enforced here (before buffering as much as the server lets us) and
// again in the dispatcher.

import { BROWSER_DOWNLOAD_MAX_BYTES } from "./protocol";
import { encodeBase64 } from "./base64";

export type DownloadOutcome =
  | { ok: true; file: { name: string; mimeType: string; byteLength: number; base64: string } }
  | { ok: false; tooLarge: number }
  | { ok: false; message: string };

/** File name: Content-Disposition first, then the url path, then a fallback. */
export function fileNameFromResponse(url: string, disposition: string | null): string {
  if (disposition) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const raw = match?.[1];
    if (raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // not an absolute url: fall through to the generic name
  }
  return "download";
}

/** Fetch one file in the page session; the outcome is data, never an exception. */
export async function fetchFile(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadOutcome> {
  try {
    const response = await fetchImpl(url, { credentials: "include", redirect: "follow" });
    if (!response.ok) return { ok: false, message: `download answered ${response.status}` };
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > BROWSER_DOWNLOAD_MAX_BYTES) {
      return { ok: false, tooLarge: declared };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BROWSER_DOWNLOAD_MAX_BYTES) {
      return { ok: false, tooLarge: buffer.byteLength };
    }
    return {
      ok: true,
      file: {
        name: fileNameFromResponse(url, response.headers.get("content-disposition")),
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
        byteLength: buffer.byteLength,
        base64: encodeBase64(new Uint8Array(buffer)),
      },
    };
  } catch (err) {
    return { ok: false, message: `download failed: ${String((err as Error)?.message ?? err)}` };
  }
}