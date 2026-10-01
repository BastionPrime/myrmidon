// myrmidon(EXTCASE-M): the server pipeline of the client's mail path.
//
// The pipeline is pure over its ports: the settings, the ledger, the attachment
// bytes, recognition, the classifier and the board task are all injected here.
// These tests are therefore about the behaviour of the case and not about the
// board: a rule decides before a model ever runs, a model failure does not lose
// the mail, a re-delivery does not move a message twice or create a second task,
// and nothing that a client's mail carried reaches the journal.

import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_MAIL_JOURNAL_ACTIONS,
  DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS,
  clientMailRuleSchema,
  type ClientMailCompanySettings,
  type ClientMailItem,
} from "@paperclipai/shared";
import {
  createMemoryClientMailLedger,
  processClientMailBatch,
  type ClientMailAttachmentSource,
  type ClientMailJournalEntry,
  type ClientMailLedger,
  type ClientMailOcr,
  type ClientMailPipelineDeps,
  type ClientMailTaskDraft,
} from "./pipeline.js";
import type { MailClassifier } from "./classifier.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function item(overrides: Partial<ClientMailItem> = {}): ClientMailItem {
  return {
    messageId: "message-a",
    receivedAt: "2026-10-01T09:00:00.000Z",
    subject: "Извещение о закупке № 44-ФЗ/12345",
    from: { address: "tender@example.com" },
    bodyText: "Номер закупки 12345. Срок подачи заявок — 15.10.2026. НМЦК 1 500 000 руб.",
    attachments: [{ attachmentId: "a-1", name: "документация.pdf", contentType: "application/pdf" }],
    ...overrides,
  };
}

function settings(overrides: Partial<ClientMailCompanySettings> = {}): ClientMailCompanySettings {
  return {
    ...DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS,
    enabled: true,
    folders: ["Tenders", "Invoices"],
    categories: ["Urgent"],
    fallbackFolder: "Triage",
    platformAgentId: AGENT_ID,
    ...overrides,
  };
}

interface Harness {
  deps: ClientMailPipelineDeps;
  journal: ClientMailJournalEntry[];
  tasks: ClientMailTaskDraft[];
  classifiedWith: ClientMailItem[];
  recognizeCalls: Array<{ name: string; size: number }>;
  settings: ClientMailCompanySettings;
}

function harness(overrides: {
  settings?: ClientMailCompanySettings;
  classifier?: MailClassifier | null;
  classifierError?: Error;
  ocr?: ClientMailOcr | null;
  attachments?: ClientMailAttachmentSource;
  ledger?: ClientMailLedger;
  taskError?: Error;
} = {}): Harness {
  const journal: ClientMailJournalEntry[] = [];
  const tasks: ClientMailTaskDraft[] = [];
  const classifiedWith: ClientMailItem[] = [];
  const recognizeCalls: Array<{ name: string; size: number }> = [];
  const companySettings = overrides.settings ?? settings();
  const ledger =
    overrides.ledger ??
    (() => {
      const memory = createMemoryClientMailLedger();
      return {
        has: memory.has,
        async record(companyId: string, entry: ClientMailJournalEntry) {
          journal.push(entry);
          await memory.record(companyId, entry);
        },
      } satisfies ClientMailLedger;
    })();

  const classifier: MailClassifier | null =
    overrides.classifier === undefined
      ? {
          model: "classifier-model",
          async classify(entry) {
            classifiedWith.push(entry);
            return { kind: "folder", folderPath: "Tenders", source: "model", reason: "tender mail" };
          },
        }
      : overrides.classifier;

  const deps: ClientMailPipelineDeps = {
    async settings() {
      return companySettings;
    },
    ledger,
    attachments:
      overrides.attachments ??
      {
        async fetchAttachment() {
          return { name: "документация.pdf", bytes: PDF_BYTES };
        },
      },
    ocr:
      overrides.ocr === undefined
        ? {
            async recognize(input) {
              recognizeCalls.push({ name: input.name, size: input.bytes.byteLength });
              return {
                text: [
                  "Извещение о проведении закупки",
                  "Номер закупки: 44-ФЗ/12345",
                  "Срок подачи заявок: 15.10.2026",
                  "НМЦК: 1 500 000,00 руб.",
                  "Участник должен предоставить обеспечение заявки.",
                ].join("\n"),
              };
            },
          }
        : overrides.ocr,
    async classifier() {
      if (overrides.classifierError) throw overrides.classifierError;
      return classifier;
    },
    tasks: {
      async createTask(draft) {
        if (overrides.taskError) throw overrides.taskError;
        tasks.push(draft);
        return { id: "task-1", identifier: "CLI-42" };
      },
    },
  };

  return { deps, journal, tasks, classifiedWith, recognizeCalls, settings: companySettings };
}

describe("processClientMailBatch", () => {
  it("refuses to process mail of a company whose path is not enabled, naming the setting", async () => {
    const h = harness({ settings: settings({ enabled: false }) });
    await expect(processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps)).rejects.toThrow(
      /general\.clientMail\.companies/,
    );
  });

  it("decides by a client rule and never calls the model", async () => {
    const h = harness({
      settings: settings({
        rules: [
          clientMailRuleSchema.parse({
            id: "r-1",
            name: "Tenders",
            match: { from: "example.com", subjectContains: "закупк" },
            decision: { kind: "folder", folderPath: "Tenders" },
          }),
        ],
      }),
      classifierError: new Error("the classifier must not be called"),
    });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.decision).toMatchObject({ kind: "folder", folderPath: "Tenders", source: "rule", ruleId: "r-1" });
    expect(h.classifiedWith).toHaveLength(0);
  });

  it("sends what no rule claimed to the model, and records the model's decision", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(h.classifiedWith).toHaveLength(1);
    expect(result.items[0]?.decision).toMatchObject({ kind: "folder", folderPath: "Tenders", source: "model" });
  });

  it("falls back to the configured folder when the classifier fails, and says why", async () => {
    const h = harness({ settings: settings({ rules: [] }), classifierError: new Error("the gateway is down") });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.decision).toMatchObject({ kind: "folder", folderPath: "Triage", source: "fallback" });
    expect(result.items[0]?.notes.join(" ")).toContain("the gateway is down");
  });

  it("keeps the message when no rule matched, no model is configured and there is no fallback folder", async () => {
    const h = harness({
      settings: settings({ rules: [], fallbackFolder: null, platformAgentId: null }),
      classifier: null,
      ocr: null,
    });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.decision).toMatchObject({ kind: "keep", source: "fallback" });
  });

  it("keeps a fallback decision out of the moved-mail journal action", async () => {
    const h = harness({
      settings: settings({ rules: [], fallbackFolder: null }),
      classifier: null,
      ocr: null,
    });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(h.journal[0]?.action).toBe(CLIENT_MAIL_JOURNAL_ACTIONS.itemSkipped);
  });

  it("skips a message it already decided, without a second model call, read or task", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    const again = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(again.items[0]?.processed).toBe(false);
    expect(h.classifiedWith).toHaveLength(1);
    expect(h.recognizeCalls).toHaveLength(1);
    expect(h.tasks).toHaveLength(1);
  });

  it("scopes the skip to one company: the same message id in another company is decided", async () => {
    const ledger = createMemoryClientMailLedger();
    const first = harness({ settings: settings({ rules: [] }), ledger });
    await processClientMailBatch({ companyId: "company-a", items: [item()] }, first.deps);
    const second = harness({ settings: settings({ rules: [] }), ledger });
    const result = await processClientMailBatch({ companyId: "company-b", items: [item()] }, second.deps);
    expect(result.items[0]?.processed).toBe(true);
  });

  it("refuses one malformed item without losing the rest of the batch", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    const result = await processClientMailBatch(
      { companyId: COMPANY_ID, items: [{ messageId: "broken" }, item()] },
      h.deps,
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.processed).toBe(false);
    expect(result.items[0]?.notes.join(" ")).toContain("refused");
    expect(result.items[1]?.processed).toBe(true);
  });
});

describe("recognition and the board task", () => {
  it("recognizes a PDF attachment and creates one board task with the tender fields", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(h.recognizeCalls).toEqual([{ name: "документация.pdf", size: PDF_BYTES.byteLength }]);
    expect(result.items[0]?.task).toEqual({ id: "task-1", identifier: "CLI-42" });

    const draft = h.tasks[0]!;
    expect(draft.companyId).toBe(COMPANY_ID);
    expect(draft.assigneeAgentId).toBe(AGENT_ID);
    expect(draft.idempotencyKey).toBe(`client-mail:${COMPANY_ID}:message-a`);
    expect(draft.title).toContain("44-ФЗ/12345");
    expect(draft.description).toContain('"number": "44-ФЗ/12345"');
    expect(draft.description).toContain('"date": "2026-10-15"');
    expect(draft.description).toContain("1500000");
    expect(draft.description).toContain("Участник должен предоставить обеспечение заявки.");
  });

  it("only recognizes PDF attachments", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    await processClientMailBatch(
      {
        companyId: COMPANY_ID,
        items: [
          item({
            attachments: [
              { attachmentId: "a-1", name: "смета.xlsx", contentType: "application/vnd.ms-excel" },
              { attachmentId: "a-2", name: "документация.pdf", contentType: "application/octet-stream" },
            ],
          }),
        ],
      },
      h.deps,
    );
    expect(h.recognizeCalls.map((call) => call.name)).toEqual(["документация.pdf"]);
  });

  it("notes an unreadable attachment and still sorts the message", async () => {
    const h = harness({
      settings: settings({ rules: [] }),
      attachments: {
        async fetchAttachment() {
          throw new Error("the module channel is not wired in");
        },
      },
    });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.processed).toBe(true);
    expect(result.items[0]?.task).toBeNull();
    expect(result.items[0]?.notes.join(" ")).toContain("could not be recognized");
  });

  it("creates no task when no platform bot is configured, and says so", async () => {
    const h = harness({ settings: settings({ rules: [], platformAgentId: null }) });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.task).toBeNull();
    expect(result.items[0]?.notes.join(" ")).toContain("no platform bot");
    expect(h.tasks).toHaveLength(0);
  });

  it("creates no task for a document with no tender fields", async () => {
    const h = harness({
      settings: settings({ rules: [] }),
      ocr: { async recognize() { return { text: "Общие положения договора без полей закупки." }; } },
    });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.task).toBeNull();
    expect(result.items[0]?.notes.join(" ")).toContain("no tender fields");
  });

  it("notes a failed task creation without losing the decision", async () => {
    const h = harness({ settings: settings({ rules: [] }), taskError: new Error("the agent is gone") });
    const result = await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(result.items[0]?.processed).toBe(true);
    expect(result.items[0]?.decision).toMatchObject({ kind: "folder" });
    expect(result.items[0]?.notes.join(" ")).toContain("the agent is gone");
  });

  it("does nothing about attachments when the message has none", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item({ attachments: [] })] }, h.deps);
    expect(h.recognizeCalls).toHaveLength(0);
    expect(h.tasks).toHaveLength(0);
  });
});

describe("the journal", () => {
  it("records metadata only: no subject, no body, no attachment bytes", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    const serialized = JSON.stringify(h.journal);
    expect(serialized).not.toContain("Извещение о закупке");
    expect(serialized).not.toContain("Номер закупки 12345");
    expect(serialized).not.toContain("обеспечение заявки");
    // The attachment bytes are never journalled; only their name, size and the
    // character count of the recognized text.
    expect(serialized).not.toContain(Buffer.from(PDF_BYTES).toString("base64"));
  });

  it("records the decision, its source and the rules that were tried", async () => {
    const h = harness({
      settings: settings({
        rules: [
          clientMailRuleSchema.parse({ id: "r-1", name: "Invoices", priority: 10, match: { subjectContains: "счёт" }, decision: { kind: "folder", folderPath: "Invoices" } }),
          clientMailRuleSchema.parse({ id: "r-2", name: "Tenders", priority: 20, match: { subjectContains: "закупк" }, decision: { kind: "folder", folderPath: "Tenders" } }),
        ],
      }),
    });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    const first = h.journal.find((entry) => entry.action === CLIENT_MAIL_JOURNAL_ACTIONS.itemClassified)!;
    expect(first.details).toMatchObject({ decision: "folder", target: "folder:Tenders", source: "rule", ruleId: "r-2" });
    expect(first.details.rulesTried).toEqual(["Invoices"]);
  });

  it("records the recognized attachment by name, size and character count", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    const entry = h.journal.find((row) => row.action === CLIENT_MAIL_JOURNAL_ACTIONS.attachmentRecognized)!;
    expect(entry.details).toMatchObject({ name: "документация.pdf", sizeBytes: PDF_BYTES.byteLength });
    expect(typeof entry.details.chars).toBe("number");
  });

  it("records the created task with the counts of the dossier it carried", async () => {
    const h = harness({ settings: settings({ rules: [] }) });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    const entry = h.journal.find((row) => row.action === CLIENT_MAIL_JOURNAL_ACTIONS.taskCreated)!;
    expect(entry.details).toMatchObject({ taskId: "task-1", identifier: "CLI-42", hasNumber: true, attachments: 1 });
  });
});

describe("the ledger port", () => {
  it("asks the ledger before doing any work, one company at a time", async () => {
    const has = vi.fn(async () => false);
    const record = vi.fn(async () => {});
    const h = harness({ settings: settings({ rules: [] }), ledger: { has, record } });
    await processClientMailBatch({ companyId: COMPANY_ID, items: [item()] }, h.deps);
    expect(has).toHaveBeenCalledWith(COMPANY_ID, "message-a");
    expect(record).toHaveBeenCalled();
  });
});