import type { Request, Response } from "express";
import { HttpError } from "../errors.js";

/**
 * Myrmidon (P9): every failure of the MCP protocol endpoint answers with a
 * JSON-RPC error body. A plain `{ error }` body reached MCP clients as the SDK's
 * data-less "Server returned an error response", which a client can count as a
 * transport failure of the whole gateway server instead of one failed request.
 *
 * `ToolGatewayHttpError` keeps its own vendor branch; this handles the rest:
 * - `HttpError`: its HTTP status, code -32000 for 4xx / -32603 for 5xx,
 *   `data.reasonCode` "http_error" / "internal_error", status and details;
 * - anything else: HTTP 500, code -32603, `data.reasonCode` "internal_error".
 */
export function sendMcpProtocolErrorBody(req: Request, res: Response, err: unknown): void {
  const id = (req.body as { id?: unknown } | undefined)?.id ?? null;
  if (err instanceof HttpError) {
    const details =
      err.details && typeof err.details === "object" && !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : {};
    const serverError = err.status >= 500;
    res.status(err.status).json({
      jsonrpc: "2.0",
      id,
      error: {
        code: serverError ? -32603 : -32000,
        message: err.message,
        data: { reasonCode: serverError ? "internal_error" : "http_error", status: err.status, ...details },
      },
    });
    return;
  }
  res.status(500).json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: err instanceof Error ? err.message : String(err),
      data: { reasonCode: "internal_error" },
    },
  });
}
