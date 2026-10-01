import { z } from "zod";

/**
 * Client mail contract (myrmidon EXTCASE-M).
 *
 * One place for everything the mail path of the first third-party case shares:
 * the mail module inside the client's Windows connector service produces the
 * items, the board's server pipeline classifies them and answers with a
 * disposition, and the client's own rules and the tender dossier are read by
 * the panel. The two sides must not drift, so the wire shapes, the action
 * names, the decision vocabulary and the limits live here.
 *
 * The client PC holds the mailbox: the module talks to the installed Outlook
 * client through its object model (COM/MAPI) in the user session, so the path
 * depends on no mail server type. Only the classic desktop Outlook exposes COM;
 * the new Outlook does not, and the module reports that as a status instead of
 * failing silently (see `CLIENT_MAIL_MODULE_ERRORS`).
 *
 * Nothing in this contract carries credentials, the PIN, message bodies of a
 * client's mail into a journal, or attachment bytes: the module sends an item
 * and, on request, the bytes of one attachment over the connector channel.
 */

/** Panel base path of the mail path (board-authenticated reads/writes). */
export const CLIENT_MAIL_PANEL_BASE = "/api/myrmidon/client-mail";

/**
 * Actions the board may ask of the mail module. `mail.list` and `mail.read` are
 * how the module is polled; the rest apply a decision. The module is the only
 * side that touches Outlook, so every action is a request the module may refuse
 * (Outlook closed, the new client, a folder that does not exist).
 */
export const CLIENT_MAIL_MODULE_ACTIONS = [
  "mail.status",
  "mail.list",
  "mail.read",
  "mail.attachment.save",
  "mail.move",
  "mail.categorize",
  "mail.draft",
] as const;

export type ClientMailModuleAction = (typeof CLIENT_MAIL_MODULE_ACTIONS)[number];

/**
 * Why the module cannot serve a request. These are reported values, never
 * thrown across the channel: the board journals the reason and tells the
 * operator, rather than retrying a call that cannot succeed.
 *
 * `outlook_new_client` is the documented dead end of this path: the new Outlook
 * has no COM interface, so the module detects it and says so instead of
 * pretending the mailbox is empty.
 */
export const CLIENT_MAIL_MODULE_ERRORS = [
  "outlook_not_installed",
  "outlook_not_running",
  "outlook_new_client",
  "com_unavailable",
  "folder_not_found",
  "unsupported_action",
] as const;

export type ClientMailModuleError = (typeof CLIENT_MAIL_MODULE_ERRORS)[number];

/** What the module reports about the client's Outlook, for the panel and the journal. */
export const clientMailModuleStatusSchema = z
  .object({
    /** True when a classic Outlook process is running in the user session. */
    outlookRunning: z.boolean(),
    /** True when the running Outlook exposes the COM object model (classic client). */
    classicOutlook: z.boolean(),
    /** Set when the module cannot serve mail at all. */
    error: z.enum(CLIENT_MAIL_MODULE_ERRORS).nullable().optional(),
    /** Module build label; recorded, never interpreted. */
    moduleVersion: z.string().max(64).nullable().optional(),
  })
  .strict();

export type ClientMailModuleStatus = z.infer<typeof clientMailModuleStatusSchema>;

/** An address as the module reads it out of Outlook. */
export const mailAddressSchema = z
  .object({
    name: z.string().max(255).nullable().optional(),
    address: z.string().max(320),
  })
  .strict();

export type MailAddress = z.infer<typeof mailAddressSchema>;

/**
 * One attachment of a message. The bytes are not part of an item: the module
 * names the attachment, and the pipeline asks for the bytes of the ones it
 * needs (a PDF goes to recognition) with `mail.attachment.save`.
 */
export const mailAttachmentRefSchema = z
  .object({
    /** Module-side identifier of the attachment within its message. */
    attachmentId: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative().nullable().optional(),
    contentType: z.string().max(255).nullable().optional(),
  })
  .strict();

export type MailAttachmentRef = z.infer<typeof mailAttachmentRefSchema>;

/**
 * One mail item as the module sends it.
 *
 * `messageId` is the module's stable identifier of the message (the Outlook
 * entry id). The pipeline is idempotent on it: a re-delivery after a channel
 * reconnect carries the same id and is skipped, so a reconnect cannot move a
 * message twice or create a second board task for it.
 */
export const clientMailItemSchema = z
  .object({
    messageId: z.string().min(1).max(512),
    /** Conversation/thread id, when the module has one. */
    conversationId: z.string().max(512).nullable().optional(),
    /** ISO-8601 instant the message was received. */
    receivedAt: z.string().min(1).max(64),
    subject: z.string().max(2000),
    from: mailAddressSchema.nullable().optional(),
    to: z.array(mailAddressSchema).max(200).optional(),
    /** Plain-text body as recognized by the module. */
    bodyText: z.string().max(2_000_000).optional(),
    /** Outlook folder the message currently lives in. */
    folderPath: z.string().max(1024).nullable().optional(),
    /** Categories already set on the message. */
    categories: z.array(z.string().max(255)).max(64).optional(),
    attachments: z.array(mailAttachmentRefSchema).max(200).optional(),
    /** Mailbox the message came from, so one board can serve several mailboxes. */
    mailbox: z.string().max(320).nullable().optional(),
  })
  .strict();

export type ClientMailItem = z.infer<typeof clientMailItemSchema>;

/** One delivery of the channel: items plus the watermark the module advanced to. */
export const clientMailBatchSchema = z
  .object({
    /** Opaque module-side cursor the next `mail.list` continues from. */
    watermark: z.string().max(512),
    items: z.array(clientMailItemSchema).max(500),
  })
  .strict();

export type ClientMailBatch = z.infer<typeof clientMailBatchSchema>;

/**
 * The decision: what the module should do with a message, or `keep` when
 * nothing matched and the pipeline deliberately leaves the message alone.
 *
 * A disposition never carries a model's free text: the pipeline validates the
 * answer against the company's configured folders and categories before it
 * becomes a decision, and `reason` is a short note for the journal.
 */
export const CLIENT_MAIL_DECISION_KINDS = ["keep", "folder", "category"] as const;
export type ClientMailDecisionKind = (typeof CLIENT_MAIL_DECISION_KINDS)[number];

export const CLIENT_MAIL_DECISION_SOURCES = ["rule", "model", "fallback"] as const;
export type ClientMailDecisionSource = (typeof CLIENT_MAIL_DECISION_SOURCES)[number];

export const clientMailDecisionSchema = z
  .object({
    kind: z.enum(CLIENT_MAIL_DECISION_KINDS),
    /** Target folder inside the mailbox, when `kind` is `folder`. */
    folderPath: z.string().min(1).max(1024).nullable().optional(),
    /** Categories to set, when `kind` is `category`. */
    categories: z.array(z.string().min(1).max(255)).max(64).nullable().optional(),
    /** Who decided: a client rule, the model, or the fallback folder. */
    source: z.enum(CLIENT_MAIL_DECISION_SOURCES),
    /** Id of the rule that matched, when `source` is `rule`. */
    ruleId: z.string().max(64).nullable().optional(),
    /** One line for the journal; never a body or a subject. */
    reason: z.string().max(400).nullable().optional(),
  })
  .strict();

export type ClientMailDecision = z.infer<typeof clientMailDecisionSchema>;

/** Comparison a client rule uses; every present field must match (AND). */
export const clientMailRuleMatchSchema = z
  .object({
    /** Address or domain: `billing@example.com` or `example.com`. */
    from: z.string().max(320).nullable().optional(),
    subjectContains: z.string().max(255).nullable().optional(),
    bodyContains: z.string().max(255).nullable().optional(),
    /** True — only messages with attachments; false — only messages without. */
    hasAttachment: z.boolean().nullable().optional(),
    /** Category already present on the message. */
    hasCategory: z.string().max(255).nullable().optional(),
  })
  .strict();

export type ClientMailRuleMatch = z.infer<typeof clientMailRuleMatchSchema>;

export const clientMailRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    /** Lower runs first; ties keep the array order. */
    priority: z.number().int().min(0).max(10_000).default(100),
    /** Case-insensitive; terms are compared against the same field. */
    match: clientMailRuleMatchSchema,
    /** What the message is moved/relabelled to when the rule matches (`keep` is not a rule outcome). */
    decision: z
      .object({
        kind: z.enum(["folder", "category"]),
        folderPath: z.string().min(1).max(1024).nullable().optional(),
        categories: z.array(z.string().min(1).max(255)).max(64).nullable().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.decision.kind === "folder" && !rule.decision.folderPath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision", "folderPath"], message: "a folder rule needs folderPath" });
    }
    if (rule.decision.kind === "category" && (rule.decision.categories ?? []).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision", "categories"], message: "a category rule needs at least one category" });
    }
  });

export type ClientMailRule = z.infer<typeof clientMailRuleSchema>;

/** Limits shared by the panel, the pipeline and the module. */
export const CLIENT_MAIL_MAX_RULES = 200;
export const CLIENT_MAIL_MAX_FOLDERS = 200;
export const CLIENT_MAIL_MAX_CATEGORIES = 200;
export const CLIENT_MAIL_MAX_ITEMS_PER_BATCH = 500;
/** Body characters the pipeline hands to the classifier; the rest is not sent to a model. */
export const CLIENT_MAIL_DEFAULT_MAX_BODY_CHARS = 4000;

/**
 * What one client company configured for its mail path. Stored in the instance
 * settings row under `general.clientMail.companies[companyId]`, one entry per
 * client company, so the isolation the case requires (its own agents, secrets
 * and journal) holds for the mail rules too.
 */
export const clientMailCompanySettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Folders the pipeline may move a message to (the model picks from these). */
    folders: z.array(z.string().min(1).max(1024)).max(CLIENT_MAIL_MAX_FOLDERS).default([]),
    /** Categories the pipeline may set. */
    categories: z.array(z.string().min(1).max(255)).max(CLIENT_MAIL_MAX_CATEGORIES).default([]),
    /** Where an undecided message goes; `null` means it is left alone. */
    fallbackFolder: z.string().max(1024).nullable().default(null),
    /** Board agent of the client's tender bot, which receives the task. */
    platformAgentId: z.string().uuid().nullable().default(null),
    /** Model the classifier asks through the gateway; `null` disables the model step. */
    classifierModel: z.string().max(255).nullable().default(null),
    /**
     * Name of the company secret holding the classifier's gateway key. A name,
     * never a value: the key is read from that company's secrets at call time,
     * so one client's key can never be used for another client's mail.
     */
    classifierKeySecret: z.string().max(255).nullable().default(null),
    maxBodyChars: z.number().int().positive().max(200_000).default(CLIENT_MAIL_DEFAULT_MAX_BODY_CHARS),
    rules: z.array(clientMailRuleSchema).max(CLIENT_MAIL_MAX_RULES).default([]),
  })
  .strict();

export type ClientMailCompanySettings = z.infer<typeof clientMailCompanySettingsSchema>;

export const DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS: ClientMailCompanySettings = {
  enabled: false,
  folders: [],
  categories: [],
  fallbackFolder: null,
  platformAgentId: null,
  classifierModel: null,
  classifierKeySecret: null,
  maxBodyChars: CLIENT_MAIL_DEFAULT_MAX_BODY_CHARS,
  rules: [],
};

/** The stored shape of `instance_settings.general.clientMail`. */
export const clientMailSettingsSchema = z
  .object({
    companies: z.record(z.string(), clientMailCompanySettingsSchema).default({}),
  })
  .strict();

export type ClientMailSettings = z.infer<typeof clientMailSettingsSchema>;

/** Patch of one company's mail settings: absent keys keep their stored value. */
export const clientMailCompanySettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    folders: z.array(z.string().min(1).max(1024)).max(CLIENT_MAIL_MAX_FOLDERS).optional(),
    categories: z.array(z.string().min(1).max(255)).max(CLIENT_MAIL_MAX_CATEGORIES).optional(),
    fallbackFolder: z.string().max(1024).nullable().optional(),
    platformAgentId: z.string().uuid().nullable().optional(),
    classifierModel: z.string().max(255).nullable().optional(),
    classifierKeySecret: z.string().max(255).nullable().optional(),
    maxBodyChars: z.number().int().positive().max(200_000).optional(),
    rules: z.array(clientMailRuleSchema).max(CLIENT_MAIL_MAX_RULES).optional(),
  })
  .strict();

export type ClientMailCompanySettingsPatch = z.infer<typeof clientMailCompanySettingsPatchSchema>;

/**
 * A read stored value that is unusable (a hand-edited row, an older shape) is
 * replaced by the default as a whole for that company instead of failing the
 * read: one broken company entry must not take the mail path of the others
 * down. So the companies map is read entry by entry, and only a value that is
 * not a companies map at all gives an empty one.
 */
export function normalizeClientMailSettings(raw: unknown): ClientMailSettings {
  if (typeof raw !== "object" || raw === null) return { companies: {} };
  const container = (raw as { companies?: unknown }).companies;
  if (typeof container !== "object" || container === null || Array.isArray(container)) return { companies: {} };
  const companies: Record<string, ClientMailCompanySettings> = {};
  for (const [companyId, entry] of Object.entries(container)) {
    const company = clientMailCompanySettingsSchema.safeParse(entry);
    companies[companyId] = company.success
      ? { ...company.data }
      : { ...DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS };
  }
  return { companies };
}

/** The settings of one company: the stored entry, or the default. */
export function clientMailCompanySettings(
  settings: ClientMailSettings,
  companyId: string,
): ClientMailCompanySettings {
  return settings.companies[companyId] ?? { ...DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS };
}

/** Address or domain of a `from` term, lower-cased, angle brackets stripped. */
export function normalizeMailAddressTerm(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const bracketed = /<([^>]+)>/.exec(trimmed);
  return (bracketed?.[1] ?? trimmed).replace(/^mailto:/, "");
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * Whether one rule matches one message. Every present field of `match` must
 * hold. Exported (and shared) because the panel previews a rule against a
 * sample message with the same function the pipeline uses — a preview that
 * decides differently from the pipeline would be worse than no preview.
 */
export function mailRuleMatches(rule: ClientMailRule, item: ClientMailItem): boolean {
  const match = rule.match;
  if (match.from) {
    const from = item.from?.address ? normalizeMailAddressTerm(item.from.address) : "";
    const term = normalizeMailAddressTerm(match.from);
    if (!from) return false;
    // A bare domain matches the domain part only; a full address matches exactly.
    if (term.includes("@")) {
      if (from !== term) return false;
    } else if (!from.endsWith(`@${term}`) && from !== term) {
      return false;
    }
  }
  if (match.subjectContains && !contains(item.subject ?? "", match.subjectContains)) return false;
  if (match.bodyContains && !contains(item.bodyText ?? "", match.bodyContains)) return false;
  if (match.hasCategory && !(item.categories ?? []).some((value) => contains(value, match.hasCategory!))) {
    return false;
  }
  if (match.hasAttachment !== null && match.hasAttachment !== undefined) {
    const hasAttachments = (item.attachments ?? []).length > 0;
    if (match.hasAttachment !== hasAttachments) return false;
  }
  return true;
}

/**
 * The matching rules in the order they are tried: enabled first, then by
 * priority, ties in array order. A disabled rule never matches, so an operator
 * can keep a rule in the list without it acting on mail.
 */
export function orderedMailRules(rules: ClientMailRule[]): ClientMailRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter((entry) => entry.rule.enabled)
    .sort((left, right) => left.rule.priority - right.rule.priority || left.index - right.index)
    .map((entry) => entry.rule);
}

/** The decision a rule produces. `source` is `rule`; `reason` names the rule for the journal. */
export function decisionFromRule(rule: ClientMailRule): ClientMailDecision {
  return rule.decision.kind === "folder"
    ? {
        kind: "folder",
        folderPath: rule.decision.folderPath ?? null,
        source: "rule",
        ruleId: rule.id,
        reason: `client rule "${rule.name}"`,
      }
    : {
        kind: "category",
        categories: rule.decision.categories ?? [],
        source: "rule",
        ruleId: rule.id,
        reason: `client rule "${rule.name}"`,
      };
}

/**
 * The decision a model answer becomes, or `null` when the answer is not usable.
 *
 * The model never picks a folder or a category that the client did not
 * configure: an answer outside the configured vocabulary is dropped, and the
 * caller falls back to the configured fallback folder. That is what keeps a
 * prompt injection inside a message body from steering mail anywhere the
 * client did not allow.
 */
export function decisionFromModelAnswer(
  raw: unknown,
  settings: ClientMailCompanySettings,
): ClientMailDecision | null {
  if (typeof raw !== "object" || raw === null) return null;
  const answer = raw as { kind?: unknown; folderPath?: unknown; categories?: unknown; reason?: unknown };
  const reason = typeof answer.reason === "string" ? answer.reason.slice(0, 400) : null;
  if (answer.kind === "keep") return { kind: "keep", source: "model", reason };
  if (answer.kind === "folder") {
    const folder = typeof answer.folderPath === "string" ? answer.folderPath.trim() : "";
    if (!folder || !settings.folders.includes(folder)) return null;
    return { kind: "folder", folderPath: folder, source: "model", reason };
  }
  if (answer.kind === "category") {
    const requested = Array.isArray(answer.categories)
      ? answer.categories.filter((value): value is string => typeof value === "string")
      : [];
    const allowed = requested.filter((value) => settings.categories.includes(value));
    if (allowed.length === 0) return null;
    return { kind: "category", categories: allowed, source: "model", reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Module interface (the board's requests to the mail module)
// ---------------------------------------------------------------------------
//
// The module is the only side that touches Outlook, so every action is a request
// the module may refuse. These shapes are the interface the author of the
// connector service implements (see docs/myrmidon/client-mail.md); the board
// side of the case depends on this file alone and not on the module's own code.

/** `mail.status`: no parameters. */
export const clientMailStatusRequestSchema = z.object({ action: z.literal("mail.status") }).strict();

/** `mail.list`: continue from a watermark. An empty watermark means "from the newest messages backwards". */
export const clientMailListRequestSchema = z
  .object({
    action: z.literal("mail.list"),
    /** Opaque cursor from the previous delivery; the module owns its meaning. */
    watermark: z.string().max(512).nullable().optional(),
    /** How many items to return at most; the board's own cap applies too. */
    limit: z.number().int().positive().max(CLIENT_MAIL_MAX_ITEMS_PER_BATCH).optional(),
  })
  .strict();

/** `mail.read`: the full body of one message. */
export const clientMailReadRequestSchema = z
  .object({ action: z.literal("mail.read"), messageId: z.string().min(1).max(512) })
  .strict();

/** `mail.attachment.save`: the bytes of one attachment, base64 on the wire. */
export const clientMailAttachmentSaveRequestSchema = z
  .object({
    action: z.literal("mail.attachment.save"),
    messageId: z.string().min(1).max(512),
    attachmentId: z.string().min(1).max(255),
  })
  .strict();

/** `mail.move`: the decision of the pipeline, applied to one message. */
export const clientMailMoveRequestSchema = z
  .object({
    action: z.literal("mail.move"),
    messageId: z.string().min(1).max(512),
    /** Target folder inside the mailbox; created when the client's rules name a new one. */
    folderPath: z.string().min(1).max(1024),
  })
  .strict();

/** `mail.categorize`: set categories on one message (they are added, never replaced). */
export const clientMailCategorizeRequestSchema = z
  .object({
    action: z.literal("mail.categorize"),
    messageId: z.string().min(1).max(512),
    categories: z.array(z.string().min(1).max(255)).min(1).max(64),
  })
  .strict();

/** `mail.draft`: a draft with the given body, for a message the bot answers. */
export const clientMailDraftRequestSchema = z
  .object({
    action: z.literal("mail.draft"),
    /** Message the draft replies to; the module fills the recipients from it. */
    replyToMessageId: z.string().min(1).max(512),
    subject: z.string().max(2000),
    bodyText: z.string().max(2_000_000),
  })
  .strict();

export const clientMailModuleRequestSchema = z.discriminatedUnion("action", [
  clientMailStatusRequestSchema,
  clientMailListRequestSchema,
  clientMailReadRequestSchema,
  clientMailAttachmentSaveRequestSchema,
  clientMailMoveRequestSchema,
  clientMailCategorizeRequestSchema,
  clientMailDraftRequestSchema,
]);

export type ClientMailModuleRequest = z.infer<typeof clientMailModuleRequestSchema>;

/**
 * What the module answers. Success carries `result`, a refusal carries `error`
 * and an optional one-line `message` — a failure is data on the wire, so the
 * board journals the reason instead of guessing at a broken channel.
 */
export const clientMailModuleResponseSchema = z
  .object({
    ok: z.boolean(),
    error: z.enum(CLIENT_MAIL_MODULE_ERRORS).optional(),
    message: z.string().max(1000).optional(),
    /** Result of the action, when it succeeded; shape depends on the action. */
    result: z.unknown().optional(),
  })
  .strict();

export type ClientMailModuleResponse = z.infer<typeof clientMailModuleResponseSchema>;

/** The result of `mail.attachment.save`: base64 bytes, named as the module knows them. */
export const clientMailAttachmentPayloadSchema = z
  .object({
    messageId: z.string().min(1).max(512),
    attachmentId: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    contentType: z.string().max(255).nullable().optional(),
    base64: z.string().min(1),
  })
  .strict();

export type ClientMailAttachmentPayload = z.infer<typeof clientMailAttachmentPayloadSchema>;

/**
 * Whether the module can serve mail at all, from its status report.
 *
 * `classicOutlook` false with `outlookRunning` true is the new Outlook: it has
 * no COM object model, so no mail path exists on that machine. The board treats
 * it as a report to the operator, never as an empty mailbox — an operator told
 * "no new mail" while the module cannot read anything would look for a defect
 * that is not there.
 */
export function clientMailModuleUsable(status: ClientMailModuleStatus): boolean {
  if (status.error === "outlook_new_client" || status.error === "com_unavailable") return false;
  if (status.error === "outlook_not_installed" || status.error === "outlook_not_running") return false;
  return status.outlookRunning && status.classicOutlook;
}

/** A one-line description of a module status, for the journal and the panel. */
export function describeClientMailModuleStatus(status: ClientMailModuleStatus): string {
  if (status.error === "outlook_new_client") {
    return "the new Outlook client is running: it exposes no COM interface, so this mail path cannot read the mailbox";
  }
  if (status.error === "outlook_not_installed") return "no Outlook client is installed on the client PC";
  if (status.error === "com_unavailable") return "the Outlook object model is not reachable (COM/MAPI unavailable)";
  if (status.error === "outlook_not_running") return "Outlook is not running in the user session";
  if (!status.classicOutlook) return "the running Outlook does not expose the classic object model";
  return "classic Outlook is running and exposes its object model";
}

/** Fields of the tender dossier a recognized document is read for. */
export const tenderDossierSchema = z
  .object({
    /** Procurement number as written in the document, normalized to one line. */
    number: z.string().max(255).nullable(),
    /** Deadlines: the line and, when it carried a full date, the date as `YYYY-MM-DD`. */
    deadlines: z
      .array(z.object({ text: z.string().max(400), date: z.string().max(10).nullable() }).strict())
      .max(50),
    /** Sums: the amount in minor units is not assumed; the raw text and the number are kept. */
    sums: z
      .array(
        z
          .object({
            text: z.string().max(400),
            amount: z.number(),
            currency: z.string().max(8).nullable(),
          })
          .strict(),
      )
      .max(50),
    /** Requirements: one line each. */
    requirements: z.array(z.string().max(400)).max(50),
    /** Message the dossier came from. */
    messageId: z.string().max(512),
    /** Recognized attachment names, in the order they were read. */
    attachments: z.array(z.string().max(255)).max(50),
  })
  .strict();

export type TenderDossier = z.infer<typeof tenderDossierSchema>;

/** Journal actions of the mail path; metadata only, never a body or a subject. */
export const CLIENT_MAIL_JOURNAL_ACTIONS = {
  itemClassified: "myrmidon.client_mail.item.classified",
  itemSkipped: "myrmidon.client_mail.item.skipped",
  attachmentRecognized: "myrmidon.client_mail.attachment.recognized",
  taskCreated: "myrmidon.client_mail.task.created",
  moduleReported: "myrmidon.client_mail.module.reported",
} as const;

/** Error codes of the pipeline; the message is what the operator sees. */
export type ClientMailErrorCode =
  | "mail_disabled"
  | "invalid_item"
  | "classifier_disabled"
  | "classifier_failed"
  | "ocr_failed"
  | "task_creation_failed"
  | "journal_failed";

/** A failure of the mail pipeline with a stable code. */
export class ClientMailError extends Error {
  readonly code: ClientMailErrorCode;

  constructor(code: ClientMailErrorCode, message: string) {
    super(message);
    this.name = "ClientMailError";
    this.code = code;
  }
}