// server/src/myrmidon/ocr/index.ts
//
// myrmidon(EXT-CASE-OCR): the entry point of the OCR path.
//
// The module answers one MCP endpoint per company — `POST
// /api/myrmidon/companies/:companyId/ocr/mcp` — which a client company's bot can
// be pointed at the same way it is pointed at any other MCP server. The runtime
// behind the endpoint resolves the contour per call: settings from the instance,
// the API key from the company's secrets (by name, never from the settings), the
// journal into the company's activity log. Nothing is cached between calls, so
// rotating the key, changing the backend or moving the address takes effect on
// the next call without a restart.
//
// The tool a bot sees is `ocr.pdf`; the mail connector and the browser bridge do
// not go through it — they call the same `recognize` with the bytes they already
// have (see `contracts.ts`), which is why the module needs neither of them to be
// built or tested.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import { createOcrBackend } from "./backend.js";
import { ocrSettingsProblem, readOcrSettings, type OcrSettings } from "./settings.js";
import {
  createDiscardOcrJournal,
  ocrPdfDocument,
  type OcrJournalEntry,
} from "./service.js";
import { extractTenderStructure } from "./structure.js";
import { OCR_PDF_TOOL_NAME, callOcrPdfTool, ocrPdfToolDefinition, ocrPdfToolInput } from "./tools.js";
import { OcrError, type OcrDocumentInput, type OcrDocumentResult } from "./types.js";
import { workspaceWriterFromDirectory } from "./workspace.js";

/** Written into the journal as the actor of a recognition; not a person and not a bot. */
export const OCR_ACTOR_ID = "myrmidon-ocr";

/** Directory for a copy of the recognized text; unset means the text only travels in the result. */
export const OCR_WORKSPACE_DIR_ENV = "MYRMIDON_OCR_WORKSPACE_DIR";

export interface OcrRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Resolves the company secret named by `MYRMIDON_OCR_KEY_SECRET`; null when it is missing. */
  readCompanyKey(companyId: string, secretName: string): Promise<string | null>;
  /** Records the metadata entry in the company's activity journal. */
  recordJournal(companyId: string, entry: OcrJournalEntry): Promise<void>;
  /** Copy of the text on disk, when a deployment wants one. */
  workspaceDir?: string | null;
  /** Pre-resolved settings; tests pass them, the server reads the environment. */
  settings?: OcrSettings;
}

export interface OcrRuntime {
  settings(): OcrSettings;
  /** Recognize a document that a producer already fetched (mail attachment, bridge download). */
  recognize(companyId: string, input: OcrDocumentInput): Promise<OcrDocumentResult>;
  /** Run the `ocr.pdf` tool with a bot's arguments. */
  callTool(companyId: string, args: unknown): Promise<OcrDocumentResult>;
}

export function createOcrRuntime(options: OcrRuntimeOptions): OcrRuntime {
  const env = options.env ?? process.env;
  const settings = options.settings ?? readOcrSettings(env);
  const workspace = workspaceWriterFromDirectory(options.workspaceDir ?? env[OCR_WORKSPACE_DIR_ENV]);

  const recognize = async (companyId: string, input: OcrDocumentInput): Promise<OcrDocumentResult> => {
    const problem = ocrSettingsProblem(settings);
    if (problem) throw new OcrError("ocr_disabled", problem);
    const key = settings.keySecret ? await options.readCompanyKey(companyId, settings.keySecret) : null;
    if (!key) {
      throw new OcrError(
        "ocr_disabled",
        `the OCR API key secret "${settings.keySecret ?? "—"}" is not available to this company`,
      );
    }
    const backend = createOcrBackend(
      { backend: settings.backend, baseUrl: settings.baseUrl!, model: settings.model },
      { fetch: options.fetch ?? fetch, apiKey: key, timeoutMs: settings.timeoutMs },
    );
    if (!backend) {
      throw new OcrError("ocr_disabled", "the OCR backend litellm needs a model (MYRMIDON_OCR_MODEL)");
    }
    return ocrPdfDocument(input, {
      settings,
      backend,
      workspace,
      journal: { record: (entry) => options.recordJournal(companyId, entry) },
    });
  };

  return {
    settings: () => settings,
    recognize,
    callTool: (companyId, args) =>
      callOcrPdfTool(args, {
        runOcr: (input) => recognize(companyId, input),
        maxBytes: settings.maxBytes,
      }),
  };
}

/** The runtime over the database: company secrets for the key, the activity log for the journal. */
export function myrmidonOcrDeps(db: Db): OcrRuntimeOptions {
  const secrets = secretService(db);
  return {
    async readCompanyKey(companyId, secretName) {
      const row = await secrets.getByName(companyId, secretName);
      if (!row) return null;
      return secrets.resolveSecretValue(companyId, row.id, "latest");
    },
    async recordJournal(companyId, entry) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: OCR_ACTOR_ID,
        action: entry.action,
        entityType: "ocr_document",
        entityId: entry.metadata.sourceId ?? entry.metadata.name,
        // myrmidon(EXT-CASE-OCR): metadata only — the entry is built from
        // `OcrDocumentMetadata`, which has no field for the text.
        details: { ...entry.metadata },
      });
    },
  };
}

/** The company's OCR MCP endpoint. */
export function myrmidonOcrRoutes(db: Db, runtime: OcrRuntime = createOcrRuntime(myrmidonOcrDeps(db))) {
  const router = Router();

  router.post("/myrmidon/companies/:companyId/ocr/mcp", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
    const id = body.id ?? null;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });

    if (body.method === "initialize") {
      return send({
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myrmidon-ocr", version: "1" },
      });
    }
    if (body.method === "notifications/initialized") return res.status(202).end();
    if (body.method === "tools/list") {
      return send({ tools: [ocrPdfToolDefinition] });
    }
    if (body.method !== "tools/call") {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }

    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (params.name !== OCR_PDF_TOOL_NAME) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
      });
    }
    try {
      const result = await runtime.callTool(companyId, params.arguments ?? {});
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      // A failed recognition is a tool result, not a transport error: the bot
      // sees the stable code and can decide (a different file, a report to its
      // operator) instead of retrying the same call blindly.
      const code = error instanceof OcrError ? error.code : "unknown";
      return send({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "OCR failed" }],
        structuredContent: { code },
      });
    }
  });

  return router;
}

export {
  callOcrPdfTool,
  createOcrBackend,
  createDiscardOcrJournal,
  extractTenderStructure,
  ocrPdfDocument,
  ocrPdfToolDefinition,
  ocrPdfToolInput,
  readOcrSettings,
  OCR_PDF_TOOL_NAME,
  workspaceWriterFromDirectory,
};
export { OCR_JOURNAL_ACTION, type OcrJournalEntry } from "./service.js";
export { ocrInputFromBrowserDownload, ocrInputFromMailAttachment } from "./contracts.js";
export type { BrowserDownloadLike, MailAttachmentLike } from "./contracts.js";
export type { OcrBackend } from "./backend.js";
export type { TenderStructureLimits } from "./structure.js";
export type { OcrWorkspaceWriter } from "./workspace.js";
export * from "./types.js";