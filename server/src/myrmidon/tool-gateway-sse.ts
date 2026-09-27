import type { Request, Response } from "express";

/**
 * MCP Streamable HTTP: a GET that asks for an SSE stream must be answered
 * either with an event stream or with 405. The tool gateway does not offer a
 * server-initiated stream, so such a GET gets 405 with `Allow: POST`. A plain
 * GET (no `text/event-stream` in Accept) keeps the vendor's JSON transport card.
 *
 * Returns true when the response has been sent.
 */
export function rejectMcpGatewaySseGet(req: Request, res: Response): boolean {
  const accept = req.headers.accept;
  const acceptValue = Array.isArray(accept) ? accept.join(",") : String(accept ?? "");
  if (!acceptValue.toLowerCase().includes("text/event-stream")) return false;
  res.status(405).set("Allow", "POST").json({
    error: "SSE stream is not supported on this endpoint; use POST (streamable HTTP)",
  });
  return true;
}
