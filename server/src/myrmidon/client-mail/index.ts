// server/src/myrmidon/client-mail/index.ts
//
// myrmidon(EXTCASE-M): the entry point of the client's mail path.
//
// One runtime per process, built on demand and shared by the two call sites: the
// panel routes mounted in `server/app.ts` and the ingestion route a client's
// channel delivers a batch to. They must share it, so the settings an operator
// saves are the settings the very next batch is processed with — nothing is
// cached between calls.
//
// Everything is resolved per call: the settings from the board row, the model and
// the gateway key of the classifier from that company's own configuration and
// secrets, the OCR contour from the environment. Rotating a key, changing a
// folder or naming a different platform bot therefore takes effect on the next
// batch without a restart.
//
// What this file deliberately does *not* do: send anything to a client PC. The
// channel to the module (channel.ts) is a port, and the transport that carries it
// belongs to the connector service part of the case. That is what keeps this half
// buildable and testable on its own.
//
// The one port that is knowingly unwired here is the attachment bytes: they come
// back over that same channel, which does not exist on the board yet. Until it
// does, an item's PDF is reported as an unreadable attachment in the item's notes
// and the message is still sorted correctly — recognition is an addition to the
// mail path, not a dependency of it.

import type { Db } from "@paperclipai/db";
import { clientMailCompanySettings } from "@paperclipai/shared";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import { BOT_LLM_BASE_URL_ENV } from "../bot-containers/profile-input.js";
import { createMailClassifier, type MailClassifier } from "./classifier.js";
import { createClientMailOcr, readClientMailOcrSettings } from "./ocr.js";
import { processClientMailBatch, type ClientMailPipelineDeps } from "./pipeline.js";
import {
  CLIENT_MAIL_SETTINGS_UPDATED_ACTION,
  clientMailBatchRoutes,
  clientMailPanelRoutes,
  type ClientMailRoutesDeps,
} from "./routes.js";
import {
  createDbClientMailLedger,
  patchClientMailCompanySettings,
  readClientMailLedger,
  readClientMailSettings,
} from "./store.js";
import { createClientMailTaskCreator } from "./tasks.js";

/** The gateway the classifier asks through: its own name, falling back to the bots' gateway. */
export const CLIENT_MAIL_LLM_BASE_URL_ENV = "MYRMIDON_CLIENT_MAIL_LLM_BASE_URL";
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 60_000;

/**
 * The address the classifier asks, or null.
 *
 * The mail path has its own variable and falls back to the address the bots of
 * the instance already use: one deployment therefore configures the gateway
 * once, while a deployment that wants the client's mail classified through a
 * different address (a separate contour for a client's data) names it here.
 */
export function readClassifierBaseUrl(env: NodeJS.ProcessEnv): string | null {
  return env[CLIENT_MAIL_LLM_BASE_URL_ENV]?.trim() || env[BOT_LLM_BASE_URL_ENV]?.trim() || null;
}

export interface ClientMailRuntime {
  /** Processes one batch through the pipeline; the ingestion route calls this. */
  processBatch(
    input: { companyId: string; items: unknown[] },
  ): Promise<Awaited<ReturnType<typeof processClientMailBatch>>>;
}

export interface ClientMailRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The OCR contour, when the deployment configured one; null disables recognition. */
  ocr?: ClientMailPipelineDeps["ocr"];
  /** The attachment bytes; the caller wires them to the module's channel. */
  attachments?: ClientMailPipelineDeps["attachments"];
}

/** The company's secret value by name, or null when the company has no such secret. */
export function clientMailSecretReader(db: Db) {
  const secrets = secretService(db);
  return async (companyId: string, secretName: string): Promise<string | null> => {
    const row = await secrets.getByName(companyId, secretName);
    if (!row) return null;
    return secrets.resolveSecretValue(companyId, row.id, "latest");
  };
}

/** The pipeline over the database, with the two outside ports passed in. */
export function myrmidonClientMailPipeline(db: Db, options: ClientMailRuntimeOptions = {}): ClientMailPipelineDeps {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const readSecret = clientMailSecretReader(db);
  const ocrSettings = readClientMailOcrSettings(env);
  const llmBaseUrl = readClassifierBaseUrl(env);

  return {
    async settings(companyId) {
      const stored = await readClientMailSettings(db);
      return clientMailCompanySettings(stored, companyId);
    },
    ledger: createDbClientMailLedger(db),
    attachments: options.attachments ?? {
      async fetchAttachment() {
        throw new Error("the mail module channel that carries the attachment bytes is not wired in on this board");
      },
    },
    ocr:
      options.ocr ??
      (ocrSettings.enabled
        ? createClientMailOcr({ settings: ocrSettings, fetch: fetchImpl, readCompanyKey: readSecret })
        : null),
    async classifier(companyId: string): Promise<MailClassifier | null> {
      const stored = await readClientMailSettings(db);
      const settings = clientMailCompanySettings(stored, companyId);
      if (!settings.classifierModel || !settings.classifierKeySecret || !llmBaseUrl) return null;
      return createMailClassifier(settings.classifierModel, {
        fetch: fetchImpl,
        baseUrl: llmBaseUrl,
        timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
        readApiKey: () => readSecret(companyId, settings.classifierKeySecret!),
      });
    },
    tasks: createClientMailTaskCreator(db),
  };
}

const runtimes = new WeakMap<Db, ClientMailRuntime>();

export function clientMailRuntime(db: Db, options: ClientMailRuntimeOptions = {}): ClientMailRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const pipeline = myrmidonClientMailPipeline(db, options);
  const runtime: ClientMailRuntime = { processBatch: (input) => processClientMailBatch(input, pipeline) };
  runtimes.set(db, runtime);
  return runtime;
}

/** The ports the two routers run over: the board's store, the journal and the runtime. */
export function myrmidonClientMailRouteDeps(db: Db, options: ClientMailRuntimeOptions = {}): ClientMailRoutesDeps {
  const runtime = clientMailRuntime(db, options);
  return {
    async readSettings(companyId) {
      const stored = await readClientMailSettings(db);
      return clientMailCompanySettings(stored, companyId);
    },
    patchSettings: (companyId, patch) => patchClientMailCompanySettings(db, companyId, patch),
    readLedger: (companyId, messageIds) => readClientMailLedger(db, companyId, messageIds),
    processBatch: (input) => runtime.processBatch(input),
    recordChange: (input) =>
      logActivity(db, {
        companyId: input.companyId,
        actorType: input.actorType as "agent" | "user" | "system" | "plugin",
        actorId: input.actorId,
        action: CLIENT_MAIL_SETTINGS_UPDATED_ACTION,
        entityType: "client_mail_settings",
        entityId: input.companyId,
        details: input.details,
      }),
  };
}

/** Router for app.ts: the mail settings, the ledger and the rule preview of one client company. */
export function myrmidonClientMailRoutes(db: Db, options: ClientMailRuntimeOptions = {}) {
  return clientMailPanelRoutes(myrmidonClientMailRouteDeps(db, options));
}

/** Router for app.ts: the batch a client's channel delivers. */
export function myrmidonClientMailBatchRoutes(db: Db, options: ClientMailRuntimeOptions = {}) {
  return clientMailBatchRoutes(myrmidonClientMailRouteDeps(db, options));
}