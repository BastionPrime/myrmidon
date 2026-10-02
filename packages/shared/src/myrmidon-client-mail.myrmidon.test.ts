// myrmidon(EXTCASE-M): the shared mail contract.
//
// The contract is where the client's rules, the decision vocabulary and the
// module status are decided, and both sides of the case read it: the board's
// pipeline and the panel. So these tests are about the two properties the rest
// of the feature leans on — the matcher in the panel is the matcher in the
// pipeline, and a decision can never name a folder or a category the client did
// not configure.

import { describe, expect, it } from "vitest";
import {
  CLIENT_MAIL_MAX_ITEMS_PER_BATCH,
  DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS,
  clientMailCompanySettings,
  clientMailItemSchema,
  clientMailModuleRequestSchema,
  clientMailModuleStatusSchema,
  clientMailModuleUsable,
  clientMailRuleSchema,
  clientMailSettingsSchema,
  decisionFromModelAnswer,
  decisionFromRule,
  describeClientMailModuleStatus,
  normalizeClientMailSettings,
  orderedMailRules,
  mailRuleMatches,
  type ClientMailCompanySettings,
  type ClientMailItem,
  type ClientMailRule,
} from "./myrmidon-client-mail.js";

function item(overrides: Partial<ClientMailItem> = {}): ClientMailItem {
  return {
    messageId: "message-a",
    receivedAt: "2026-10-01T09:00:00.000Z",
    subject: "Извещение о закупке № 12345",
    from: { name: "Tender desk", address: "tender@example.com" },
    bodyText: "Просим рассмотреть предложение. Срок подачи заявок — 15.10.2026.",
    attachments: [{ attachmentId: "a-1", name: "документация.pdf", contentType: "application/pdf" }],
    ...overrides,
  };
}

function rule(overrides: Partial<ClientMailRule> = {}): ClientMailRule {
  return clientMailRuleSchema.parse({
    id: "rule-a",
    name: "Tenders from the platform",
    match: { from: "example.com" },
    decision: { kind: "folder", folderPath: "Tenders" },
    ...overrides,
  });
}

function settings(overrides: Partial<ClientMailCompanySettings> = {}): ClientMailCompanySettings {
  return { ...DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS, ...overrides };
}

describe("mailRuleMatches", () => {
  it("matches a bare domain against the domain part only", () => {
    const byDomain = rule({ match: { from: "example.com" } });
    expect(mailRuleMatches(byDomain, item())).toBe(true);
    expect(mailRuleMatches(byDomain, item({ from: { address: "someone@notexample.com" } }))).toBe(false);
    expect(mailRuleMatches(byDomain, item({ from: { address: "someone@other.test" } }))).toBe(false);
  });

  it("matches a full address exactly, and reads it out of a display name", () => {
    const byAddress = rule({ match: { from: "tender@example.com" } });
    expect(mailRuleMatches(byAddress, item({ from: { name: "Desk", address: "Tender <tender@example.com>" } }))).toBe(true);
    expect(mailRuleMatches(byAddress, item({ from: { address: "other@example.com" } }))).toBe(false);
  });

  it("requires every present field of the match to hold (AND)", () => {
    const both = rule({ match: { from: "example.com", subjectContains: "закупк" } });
    expect(mailRuleMatches(both, item())).toBe(true);
    expect(mailRuleMatches(both, item({ subject: "Привет" }))).toBe(false);
  });

  it("matches on the attachment flag in both directions", () => {
    const withAttachment = rule({ match: { hasAttachment: true } });
    const withoutAttachment = rule({ match: { hasAttachment: false } });
    expect(mailRuleMatches(withAttachment, item())).toBe(true);
    expect(mailRuleMatches(withoutAttachment, item())).toBe(false);
    expect(mailRuleMatches(withoutAttachment, item({ attachments: [] }))).toBe(true);
  });

  it("matches a category already present on the message", () => {
    const byCategory = rule({ match: { hasCategory: "Urgent" } });
    expect(mailRuleMatches(byCategory, item({ categories: ["urgent"] }))).toBe(true);
    expect(mailRuleMatches(byCategory, item({ categories: ["Invoices"] }))).toBe(false);
  });

  it("refuses a message with no sender when the rule names one", () => {
    expect(mailRuleMatches(rule({ match: { from: "example.com" } }), item({ from: null }))).toBe(false);
  });

  it("refuses a folder rule without a folder and a category rule without categories", () => {
    expect(() => clientMailRuleSchema.parse({ id: "r", name: "n", match: {}, decision: { kind: "folder" } })).toThrow();
    expect(() =>
      clientMailRuleSchema.parse({ id: "r", name: "n", match: {}, decision: { kind: "category", categories: [] } }),
    ).toThrow();
  });

  it("rejects unknown keys of a rule", () => {
    expect(() =>
      clientMailRuleSchema.parse({
        id: "r",
        name: "n",
        match: {},
        decision: { kind: "folder", folderPath: "F" },
        somethingElse: true,
      }),
    ).toThrow();
  });
});

describe("orderedMailRules", () => {
  it("drops disabled rules, orders by priority and keeps the array order on a tie", () => {
    const first = rule({ id: "first", priority: 10, name: "first" });
    const second = rule({ id: "second", priority: 10, name: "second" });
    const later = rule({ id: "later", priority: 20, name: "later" });
    const off = rule({ id: "off", priority: 0, name: "off", enabled: false });
    expect(orderedMailRules([later, first, off, second]).map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "later",
    ]);
  });
});

describe("decisionFromRule", () => {
  it("names the rule in the reason so the journal says which rule fired", () => {
    const decision = decisionFromRule(rule({ id: "r-7", name: "Invoices" , decision: { kind: "category", categories: ["Invoices"] } }));
    expect(decision).toEqual({
      kind: "category",
      categories: ["Invoices"],
      source: "rule",
      ruleId: "r-7",
      reason: 'client rule "Invoices"',
    });
  });
});

describe("decisionFromModelAnswer", () => {
  const configured = settings({ folders: ["Tenders", "Invoices"], categories: ["Urgent", "Tender"] });

  it("accepts a configured folder", () => {
    expect(decisionFromModelAnswer({ kind: "folder", folderPath: "Tenders", reason: "tender mail" }, configured)).toEqual({
      kind: "folder",
      folderPath: "Tenders",
      source: "model",
      reason: "tender mail",
    });
  });

  it("drops a folder the client did not configure — a prompt injection cannot steer mail", () => {
    expect(decisionFromModelAnswer({ kind: "folder", folderPath: "Отправить в архив" }, configured)).toBeNull();
    expect(decisionFromModelAnswer({ kind: "folder", folderPath: "../../../etc" }, configured)).toBeNull();
  });

  it("keeps only the configured categories of an answer", () => {
    expect(
      decisionFromModelAnswer({ kind: "category", categories: ["Urgent", "invented"] }, configured),
    ).toEqual({ kind: "category", categories: ["Urgent"], source: "model", reason: null });
  });

  it("drops a category answer whose categories are all unknown", () => {
    expect(decisionFromModelAnswer({ kind: "category", categories: ["invented"] }, configured)).toBeNull();
  });

  it("passes keep through, and refuses anything that is not a decision", () => {
    expect(decisionFromModelAnswer({ kind: "keep", reason: "nothing matches" }, configured)).toEqual({
      kind: "keep",
      source: "model",
      reason: "nothing matches",
    });
    expect(decisionFromModelAnswer({ kind: "delete" }, configured)).toBeNull();
    expect(decisionFromModelAnswer("Tenders", configured)).toBeNull();
    expect(decisionFromModelAnswer(null, configured)).toBeNull();
  });
});

describe("module status", () => {
  it("treats the new Outlook as unusable and says so in words an operator can act on", () => {
    const status = clientMailModuleStatusSchema.parse({
      outlookRunning: true,
      classicOutlook: false,
      error: "outlook_new_client",
    });
    expect(clientMailModuleUsable(status)).toBe(false);
    expect(describeClientMailModuleStatus(status)).toContain("new Outlook");
  });

  it("treats a running classic Outlook as usable", () => {
    const status = clientMailModuleStatusSchema.parse({ outlookRunning: true, classicOutlook: true });
    expect(clientMailModuleUsable(status)).toBe(true);
    expect(describeClientMailModuleStatus(status)).toContain("classic Outlook");
  });

  it("treats a closed Outlook as unusable, not as an empty mailbox", () => {
    const status = clientMailModuleStatusSchema.parse({
      outlookRunning: false,
      classicOutlook: false,
      error: "outlook_not_running",
    });
    expect(clientMailModuleUsable(status)).toBe(false);
    expect(describeClientMailModuleStatus(status)).toBe("Outlook is not running in the user session");
  });

  it("rejects an unknown error code", () => {
    expect(() =>
      clientMailModuleStatusSchema.parse({ outlookRunning: true, classicOutlook: true, error: "something_new" }),
    ).toThrow();
  });
});

describe("module request contract", () => {
  it("accepts every documented action and refuses an unknown one", () => {
    for (const request of [
      { action: "mail.status" },
      { action: "mail.list" },
      { action: "mail.list", watermark: "cursor-1", limit: 10 },
      { action: "mail.read", messageId: "m-1" },
      { action: "mail.attachment.save", messageId: "m-1", attachmentId: "a-1" },
      { action: "mail.move", messageId: "m-1", folderPath: "Tenders" },
      { action: "mail.categorize", messageId: "m-1", categories: ["Urgent"] },
      { action: "mail.draft", replyToMessageId: "m-1", subject: "Re", bodyText: "text" },
    ]) {
      expect(clientMailModuleRequestSchema.safeParse(request).success).toBe(true);
    }
    expect(clientMailModuleRequestSchema.safeParse({ action: "mail.delete", messageId: "m-1" }).success).toBe(false);
    expect(clientMailModuleRequestSchema.safeParse({ action: "mail.categorize", messageId: "m-1", categories: [] }).success).toBe(false);
  });

  it("caps the batch limit at the contract's own maximum", () => {
    expect(
      clientMailModuleRequestSchema.safeParse({ action: "mail.list", limit: CLIENT_MAIL_MAX_ITEMS_PER_BATCH }).success,
    ).toBe(true);
    expect(
      clientMailModuleRequestSchema.safeParse({ action: "mail.list", limit: CLIENT_MAIL_MAX_ITEMS_PER_BATCH + 1 }).success,
    ).toBe(false);
  });
});

describe("item contract", () => {
  it("accepts an item without optional fields", () => {
    const parsed = clientMailItemSchema.safeParse({
      messageId: "m-1",
      receivedAt: "2026-10-01T09:00:00.000Z",
      subject: "s",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an item without a message id", () => {
    expect(clientMailItemSchema.safeParse({ receivedAt: "2026-10-01T09:00:00.000Z", subject: "s" }).success).toBe(false);
  });
});

describe("settings normalization", () => {
  it("falls back to the default for a broken company entry without losing the others", () => {
    const stored = normalizeClientMailSettings({
      companies: {
        "company-a": { enabled: true, folders: ["Tenders"], categories: [], fallbackFolder: null, platformAgentId: null, classifierModel: null, classifierKeySecret: null, maxBodyChars: 1000, rules: [] },
        "company-b": { enabled: "yes" },
      },
    });
    expect(stored.companies["company-a"]?.enabled).toBe(true);
    expect(stored.companies["company-a"]?.folders).toEqual(["Tenders"]);
    expect(stored.companies["company-b"]).toEqual(DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS);
  });

  it("returns an empty map for a value that is not a companies map at all", () => {
    expect(normalizeClientMailSettings("nonsense")).toEqual({ companies: {} });
    expect(normalizeClientMailSettings({ companies: "nope" })).toEqual({ companies: {} });
    expect(normalizeClientMailSettings({ companies: ["a"] })).toEqual({ companies: {} });
  });

  it("replaces a company entry that is not an object with the default, keeping the rest", () => {
    const stored = normalizeClientMailSettings({
      companies: { "company-a": { enabled: true }, "company-b": 42 },
    });
    expect(stored.companies["company-a"]?.enabled).toBe(true);
    expect(stored.companies["company-b"]).toEqual(DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS);
  });

  it("answers the default for a company that has no entry", () => {
    const stored = clientMailSettingsSchema.parse({ companies: {} });
    expect(clientMailCompanySettings(stored, "company-a")).toEqual(DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS);
  });

  it("rejects unknown keys of a company entry", () => {
    expect(() =>
      clientMailCompanySettingsSchemaLikeParse({
        enabled: true,
        folders: [],
        categories: [],
        fallbackFolder: null,
        platformAgentId: null,
        classifierModel: null,
        classifierKeySecret: null,
        maxBodyChars: 100,
        rules: [],
        somethingElse: 1,
      }),
    ).toThrow();
  });
});

// The schema is not exported under a second name; this indirection keeps the
// excess-property assertion above readable and typed as unknown keys.
function clientMailCompanySettingsSchemaLikeParse(value: Record<string, unknown>) {
  const parsed = clientMailSettingsSchema.parse({ companies: { "company-a": value } });
  return parsed.companies["company-a"];
}

describe("the item the module sends", () => {
  it("round-trips through the batch shape the channel parses", () => {
    const batch = { watermark: "cursor-2", items: [item()] };
    expect(batch.items[0]?.messageId).toBe("message-a");
  });
});