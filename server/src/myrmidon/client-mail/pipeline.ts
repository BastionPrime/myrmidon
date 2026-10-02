// server/src/myrmidon/client-mail/pipeline.ts
//
// myrmidon(EXTCASE-M): the board side of the client's mail path.
//
// One mail item in, one decision out, plus the work the item caused. The order
// is the whole design:
//
//   1. an item already seen (same `messageId`) is skipped before anything else
//      runs, so a channel reconnect that re-sends a batch never moves a message
//      twice and never creates a second board task for it;
//   2. the client's own rules decide first (rules.ts) — a rule match never
//      reaches a model;
//   3. only what no rule claimed goes to the classifier model, and only when the
//      client configured one; a model failure is journalled and falls back;
//   4. the decision is journalled as metadata (who decided, which rule, which
//      folder) — never a body or a subject;
//   5. PDF attachments go to recognition, and the tender fields of the
//      recognized text become a board task for the client's platform bot.
//
// Every port is injected, so the whole pipeline is exercised without a database,
// a mailbox or a model. Nothing in this file writes a message body, a subject or
// attachment bytes into a journal row: the journal carries names, sizes, counts
// and decisions.

import {
  CLIENT_MAIL_JOURNAL_ACTIONS,
  ClientMailError,
  clientMailItemSchema,
  type ClientMailCompanySettings,
  type ClientMailDecision,
  type ClientMailItem,
  type MailAttachmentRef,
} from "@paperclipai/shared";
import { buildTenderDossier, dossierIsActionable, extractTenderPart, type TenderDossierLimits } from "./dossier.js";
import { classifyByRules } from "./rules.js";
import type { MailClassifier } from "./classifier.js";

/** One journal row the pipeline asks for; metadata only, by construction. */
export interface ClientMailJournalEntry {
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

/**
 * The pipeline's record of what it has decided, and where it says so.
 *
 * One port, two jobs, because they are the same row: a decided message is
 * written to the company's activity journal, and that row is what a re-delivery
 * of the same `messageId` is recognised by. Splitting them would create a second
 * source of truth that a reconnect could disagree with.
 */
export interface ClientMailLedger {
  /** True when this message was already decided for this company. */
  has(companyId: string, messageId: string): Promise<boolean>;
  record(companyId: string, entry: ClientMailJournalEntry): Promise<void>;
}

/**
 * The bytes of one attachment. The module owns the mailbox, so it is asked for
 * the bytes of the attachments a decision needs; a failed fetch is reported and
 * never loses the mail itself.
 */
export interface ClientMailAttachmentSource {
  fetchAttachment(input: {
    messageId: string;
    attachment: MailAttachmentRef;
  }): Promise<{ name: string; bytes: Uint8Array }>;
}

/**
 * Recognition of one PDF. Narrow on purpose: the OCR path of the first case
 * (`server/src/myrmidon/ocr/`) and the OCR models behind the gateway both fit
 * behind it, and the mail pipeline needs neither to be built to be tested. Returns
 * the recognized text; the caller keeps it out of the journal.
 */
export interface ClientMailOcr {
  recognize(input: { companyId: string; name: string; bytes: Uint8Array; sourceId: string }): Promise<{ text: string }>;
}

/** The board task the mail path creates for the client's platform bot. */
export interface ClientMailTaskDraft {
  title: string;
  description: string;
  /** Company the task belongs to; the client's own company. */
  companyId: string;
  /** Board agent of the client's tender bot. */
  assigneeAgentId: string;
  /** Stable key so a re-delivery cannot create a second task for one message. */
  idempotencyKey: string;
}

export interface ClientMailTaskCreator {
  createTask(draft: ClientMailTaskDraft): Promise<{ id: string; identifier: string | null }>;
}

export interface ClientMailPipelineDeps {
  settings(companyId: string): Promise<ClientMailCompanySettings>;
  ledger: ClientMailLedger;
  attachments: ClientMailAttachmentSource;
  /** Only PDF attachments are recognized; a non-PDF is listed but not read. */
  ocr: ClientMailOcr | null;
  /**
   * The classifier of one company, or null when no model is configured for it.
   * Asynchronous because the model and the gateway key are read at call time:
   * an operator who changes the model must not have to restart the board.
   */
  classifier(companyId: string): Promise<MailClassifier | null>;
  tasks: ClientMailTaskCreator;
  /** Caps of the tender excerpt; the defaults are used when omitted. */
  dossierLimits?: TenderDossierLimits;
}

/** The outcome of one item, as the caller (the channel) reports it back. */
export interface ClientMailProcessedItem {
  messageId: string;
  /** False when the item was already processed before this call. */
  processed: boolean;
  decision: ClientMailDecision | null;
  /** Board task created for the tender dossier, when one was. */
  task: { id: string; identifier: string | null } | null;
  /** Reasons worth telling the operator: a failed model call, a failed read. */
  notes: string[];
}

export interface ClientMailProcessResult {
  items: ClientMailProcessedItem[];
}

/** An attachment is recognized when it looks like a PDF: by content type or by name. */
export function isPdfAttachment(attachment: MailAttachmentRef): boolean {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  if (contentType.includes("pdf")) return true;
  return /\.pdf$/i.test(attachment.name);
}

function describeDecision(decision: ClientMailDecision): string {
  if (decision.kind === "folder") return `folder:${decision.folderPath ?? "—"}`;
  if (decision.kind === "category") return `categories:${(decision.categories ?? []).join("|")}`;
  return "keep";
}

function taskDescription(input: {
  item: ClientMailItem;
  dossierJson: string;
  recognized: string[];
}): string {
  return [
    "Incoming mail of the client's mailbox carried tender documentation.",
    "",
    `Subject: ${input.item.subject}`,
    `From: ${input.item.from?.address ?? "unknown"}`,
    `Received: ${input.item.receivedAt}`,
    `Mailbox: ${input.item.mailbox ?? "default"}`,
    `Message id: ${input.item.messageId}`,
    "",
    "Recognized attachments:",
    ...input.recognized.map((name) => `- ${name}`),
    "",
    "Tender fields (JSON):",
    "```json",
    input.dossierJson,
    "```",
    "",
    "The recognized text is in the workspace; the JSON above is the excerpt a person reads first.",
  ].join("\n");
}

function taskTitle(dossierNumber: string | null, subject: string): string {
  const label = dossierNumber ? `Tender ${dossierNumber}` : "Tender documentation";
  const trimmed = subject.trim();
  const title = trimmed ? `${label}: ${trimmed}` : label;
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
}

/**
 * Processes one delivery of the client's mail channel.
 *
 * Every item is handled on its own: one unusable item (a malformed shape, an
 * unreadable attachment, a failed model call) never stops the rest of the
 * batch, and every outcome is journalled. The whole batch therefore reports per
 * item instead of failing as a whole.
 */
export async function processClientMailBatch(
  input: { companyId: string; items: unknown[] },
  deps: ClientMailPipelineDeps,
): Promise<ClientMailProcessResult> {
  const settings = await deps.settings(input.companyId);
  if (!settings.enabled) {
    throw new ClientMailError(
      "mail_disabled",
      `the mail path of this company is not enabled; set general.clientMail.companies.${input.companyId}.enabled`,
    );
  }

  const results: ClientMailProcessedItem[] = [];

  for (const raw of input.items) {
    const parsed = clientMailItemSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      results.push({
        messageId: "—",
        processed: false,
        decision: null,
        task: null,
        notes: [`the item was refused: ${issue?.path.join(".") || "shape"} — ${issue?.message ?? "invalid"}`],
      });
      continue;
    }
    results.push(await processOneItem(parsed.data, input.companyId, settings, deps));
  }

  return { items: results };
}

async function processOneItem(
  item: ClientMailItem,
  companyId: string,
  settings: ClientMailCompanySettings,
  deps: ClientMailPipelineDeps,
): Promise<ClientMailProcessedItem> {
  const notes: string[] = [];

  if (await deps.ledger.has(companyId, item.messageId)) {
    return { messageId: item.messageId, processed: false, decision: null, task: null, notes };
  }

  // 1. The client's rules, and only then a model.
  const byRules = classifyByRules(settings.rules, item);
  let decision = byRules.decision;

  if (!decision) {
    let classifier: MailClassifier | null = null;
    try {
      classifier = await deps.classifier(companyId);
    } catch (error) {
      // Resolving the classifier reads the company's settings and its secret;
      // a hiccup there must not lose the message, so it is treated as "no
      // classifier" and the fallback below decides.
      notes.push(`the classifier could not be resolved: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (classifier) {
      try {
        decision = await classifier.classify(item, settings);
        if (!decision) notes.push("the classifier named an option the client did not configure; using the fallback");
      } catch (error) {
        notes.push(`the classifier failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    } else if (notes.length === 0) {
      notes.push("no classifier is configured for this company");
    }
  }

  if (!decision) {
    decision = settings.fallbackFolder
      ? {
          kind: "folder",
          folderPath: settings.fallbackFolder,
          source: "fallback",
          reason: "no rule matched and no classifier decided",
        }
      : { kind: "keep", source: "fallback", reason: "no rule matched and no fallback folder is configured" };
  }

  const kind = describeDecision(decision);
  await deps.ledger.record(companyId, {
    action: decision.kind === "keep" ? CLIENT_MAIL_JOURNAL_ACTIONS.itemSkipped : CLIENT_MAIL_JOURNAL_ACTIONS.itemClassified,
    entityType: "client_mail_item",
    entityId: item.messageId,
    // Metadata only: the decision names a folder or a category, and the trace
    // names rules. Neither the subject nor the body is written down.
    details: {
      decision: decision.kind,
      target: kind,
      source: decision.source,
      ruleId: decision.ruleId ?? null,
      reason: decision.reason ?? null,
      attachments: (item.attachments ?? []).length,
      rulesTried: byRules.ruleTrace,
      notes,
    },
  });

  // 2. Recognition of the PDFs, and the board task their fields produce.
  const task = await processAttachments(item, companyId, settings, deps, notes);

  return { messageId: item.messageId, processed: true, decision, task, notes };
}

async function processAttachments(
  item: ClientMailItem,
  companyId: string,
  settings: ClientMailCompanySettings,
  deps: ClientMailPipelineDeps,
  notes: string[],
): Promise<{ id: string; identifier: string | null } | null> {
  const pdfs = (item.attachments ?? []).filter(isPdfAttachment);
  if (pdfs.length === 0) return null;
  if (!deps.ocr) {
    notes.push("the OCR path is not configured on this instance; the attachments were not recognized");
    return null;
  }
  if (!settings.platformAgentId) {
    notes.push("no platform bot is configured for this company; no board task was created");
  }

  const parts = [];
  const recognized: string[] = [];

  for (const attachment of pdfs) {
    try {
      const fetched = await deps.attachments.fetchAttachment({ messageId: item.messageId, attachment });
      const result = await deps.ocr.recognize({
        companyId,
        name: fetched.name,
        bytes: fetched.bytes,
        sourceId: item.messageId,
      });
      recognized.push(fetched.name);
      parts.push(extractTenderPart({ text: result.text, messageId: item.messageId, attachmentName: fetched.name }, deps.dossierLimits));
      await deps.ledger.record(companyId, {
        action: CLIENT_MAIL_JOURNAL_ACTIONS.attachmentRecognized,
        entityType: "client_mail_attachment",
        entityId: item.messageId,
        // Name, size and character count: the recognized text stays in the workspace.
        details: {
          name: fetched.name,
          sizeBytes: fetched.bytes.byteLength,
          chars: result.text.length,
          pages: null,
        },
      });
    } catch (error) {
      // A single unreadable attachment does not lose the message: it is noted
      // and the remaining attachments are still read.
      notes.push(
        `the attachment "${attachment.name}" could not be recognized: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  if (recognized.length === 0) return null;

  const dossier = buildTenderDossier({ parts, messageId: item.messageId, attachmentNames: recognized });
  if (!dossierIsActionable(dossier)) {
    notes.push("the recognized documents carried no tender fields; no board task was created");
    return null;
  }
  if (!settings.platformAgentId) return null;

  try {
    const task = await deps.tasks.createTask({
      companyId,
      assigneeAgentId: settings.platformAgentId,
      // One task per message: the key is stable across a re-delivery, so even a
      // race between two deliveries of the same batch cannot double the task.
      idempotencyKey: `client-mail:${companyId}:${item.messageId}`,
      title: taskTitle(dossier.number, item.subject),
      description: taskDescription({ item, dossierJson: JSON.stringify(dossier, null, 2), recognized }),
    });
    await deps.ledger.record(companyId, {
      action: CLIENT_MAIL_JOURNAL_ACTIONS.taskCreated,
      entityType: "client_mail_item",
      entityId: item.messageId,
      details: {
        taskId: task.id,
        identifier: task.identifier,
        attachments: recognized.length,
        hasNumber: Boolean(dossier.number),
        deadlines: dossier.deadlines.length,
        sums: dossier.sums.length,
        requirements: dossier.requirements.length,
      },
    });
    return task;
  } catch (error) {
    notes.push(
      `the board task for "${item.messageId}" could not be created: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return null;
  }
}

/** A ledger that keeps nothing; for a deployment that runs the path without a journal. */
export function createDiscardClientMailLedger(): ClientMailLedger {
  return {
    async has() {
      return false;
    },
    async record() {
      /* nothing to record */
    },
  };
}

/** A ledger that remembers in memory; for tests and one-shot runs. */
export function createMemoryClientMailLedger(): ClientMailLedger {
  const seen = new Set<string>();
  return {
    async has(companyId, messageId) {
      return seen.has(`${companyId}:${messageId}`);
    },
    async record(companyId, entry) {
      seen.add(`${companyId}:${entry.entityId}`);
    },
  };
}