// myrmidon(EXTCASE-M): the API of the mail path.
//
// The routes run over fake ports (settings, ledger, pipeline, journal), so
// validation, permissions, what a settings change records and what the preview
// answers are all exercised without a database.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS, ClientMailError, clientMailRuleSchema, type ClientMailCompanySettings, type ClientMailItem } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import {
  CLIENT_MAIL_SETTINGS_UPDATED_ACTION,
  clientMailBatchRoutes,
  clientMailPanelRoutes,
  type ClientMailLedgerRow,
  type ClientMailRoutesDeps,
} from "./routes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [OTHER_COMPANY_ID] };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function item(overrides: Partial<ClientMailItem> = {}): ClientMailItem {
  return {
    messageId: "m-1",
    receivedAt: "2026-10-01T09:00:00.000Z",
    subject: "Извещение о закупке",
    from: { address: "tender@example.com" },
    ...overrides,
  };
}

function companySettings(overrides: Partial<ClientMailCompanySettings> = {}): ClientMailCompanySettings {
  return { ...DEFAULT_CLIENT_MAIL_COMPANY_SETTINGS, enabled: true, folders: ["Tenders"], ...overrides };
}

interface HarnessOptions {
  stored?: ClientMailCompanySettings;
  ledger?: ClientMailLedgerRow[];
  processResult?: unknown;
  processError?: Error;
}

function harness(options: HarnessOptions = {}) {
  const patched: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let current = options.stored ?? companySettings();

  const deps: ClientMailRoutesDeps = {
    async readSettings() {
      return current;
    },
    async patchSettings(_companyId, patch) {
      current = { ...current, ...patch } as ClientMailCompanySettings;
      patched.push(patch as Record<string, unknown>);
      return current;
    },
    async readLedger() {
      return options.ledger ?? [];
    },
    async processBatch(input) {
      if (options.processError) throw options.processError;
      return options.processResult ?? { items: input.items.map(() => ({ messageId: "m-1", processed: true })) };
    },
    async recordChange(input) {
      audits.push(input as unknown as Record<string, unknown>);
      return {};
    },
  };

  const panel = clientMailPanelRoutes(deps);
  const batch = clientMailBatchRoutes(deps);
  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", panel);
    scoped.use("/api", batch);
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, patched, audits, deps };
}

const SETTINGS_URL = `/api/myrmidon/client-mail/settings/${COMPANY_ID}`;
const LEDGER_URL = `/api/myrmidon/client-mail/ledger/${COMPANY_ID}`;
const PREVIEW_URL = `/api/myrmidon/client-mail/rules/preview/${COMPANY_ID}`;
const BATCH_URL = `/api/myrmidon/companies/${COMPANY_ID}/client-mail/batch`;

describe("myrmidon(EXTCASE-M): the mail settings of one client company", () => {
  it("reads the settings for a member of that company", async () => {
    const { app } = harness({ stored: companySettings({ folders: ["Tenders", "Invoices"] }) });
    const res = await request(app).get(SETTINGS_URL).expect(200);
    expect(res.body).toEqual({
      companyId: COMPANY_ID,
      settings: expect.objectContaining({ folders: ["Tenders", "Invoices"], enabled: true }),
    });
  });

  it("refuses a member of another company", async () => {
    const { withActor } = harness();
    await request(withActor(outsider)).get(SETTINGS_URL).expect(403);
  });

  it("refuses an agent of another company", async () => {
    const { withActor } = harness();
    await request(withActor({ ...agentActor, companyId: OTHER_COMPANY_ID })).get(SETTINGS_URL).expect(403);
  });

  it("changes settings only for an instance admin, and records which keys changed", async () => {
    const { withActor, patched, audits } = harness({ stored: companySettings() });
    await request(withActor(member))
      .patch(SETTINGS_URL)
      .send({ settings: { enabled: true } })
      .expect(403);
    await request(withActor(admin))
      .patch(SETTINGS_URL)
      .send({ settings: { fallbackFolder: "Triage", folders: ["Tenders", "Invoices"] } })
      .expect(200);
    expect(patched).toEqual([{ fallbackFolder: "Triage", folders: ["Tenders", "Invoices"] }]);
    expect(audits[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "user-b",
    });
    // The keys that changed are recorded, order-independent: the patch is
    // re-parsed by the schema, so the order is the schema's, not the caller's.
    expect([...(audits[0]?.details as { keys: string[] }).keys].sort()).toEqual(["fallbackFolder", "folders"]);
  });

  it("names the audit action of a settings change", async () => {
    const { withActor, audits } = harness();
    await request(withActor(admin))
      .patch(SETTINGS_URL)
      .send({ settings: { enabled: false } })
      .expect(200);
    expect(audits[0]?.actorId).toBe("user-b");
    expect(CLIENT_MAIL_SETTINGS_UPDATED_ACTION).toBe("instance.client_mail.updated");
  });

  it("refuses a settings change carrying an unknown key", async () => {
    const { withActor } = harness();
    await request(withActor(admin))
      .patch(SETTINGS_URL)
      .send({ settings: { enabled: true, somethingElse: 1 } })
      .expect(400);
  });

  it("refuses a settings change that is not wrapped in `settings`", async () => {
    const { withActor } = harness();
    await request(withActor(admin)).patch(SETTINGS_URL).send({ enabled: true }).expect(400);
  });

  it("refuses a rule that names a folder decision without a folder", async () => {
    const { withActor } = harness();
    await request(withActor(admin))
      .patch(SETTINGS_URL)
      .send({ settings: { rules: [{ id: "r", name: "n", match: {}, decision: { kind: "folder" } }] } })
      .expect(400);
  });
});

describe("myrmidon(EXTCASE-M): the ledger of decided messages", () => {
  it("reads the rows for the named messages", async () => {
    const { app } = harness({
      ledger: [
        {
          entityId: "m-1",
          action: "myrmidon.client_mail.item.classified",
          details: { decision: "folder", target: "folder:Tenders" },
          createdAt: new Date("2026-10-01T09:00:00.000Z"),
        },
      ],
    });
    const res = await request(app).get(`${LEDGER_URL}?messageIds=m-1`).expect(200);
    expect(res.body.rows).toHaveLength(1);
  });

  it("asks for nothing when no message id was given", async () => {
    const { app, deps } = harness();
    const spy = vi.spyOn(deps, "readLedger");
    await request(app).get(LEDGER_URL).expect(200);
    expect(spy).toHaveBeenCalledWith(COMPANY_ID, []);
  });

  it("refuses a member of another company", async () => {
    const { withActor } = harness();
    await request(withActor(outsider)).get(LEDGER_URL).expect(403);
  });
});

describe("myrmidon(EXTCASE-M): previewing the client's rules", () => {
  it("answers with the rules that fired, and never with the message", async () => {
    const { app } = harness({
      stored: companySettings({
        rules: [
          clientMailRuleSchema.parse({
            id: "r-1",
            name: "Invoices",
            priority: 10,
            match: { subjectContains: "счёт" },
            decision: { kind: "folder", folderPath: "Invoices" },
          }),
          clientMailRuleSchema.parse({
            id: "r-2",
            name: "Tenders",
            priority: 20,
            match: { from: "example.com" },
            decision: { kind: "folder", folderPath: "Tenders" },
          }),
        ],
      }),
    });
    const res = await request(app).post(PREVIEW_URL).send({ item: item() }).expect(200);
    expect(res.body.matched).toEqual([
      { id: "r-2", name: "Tenders", decision: { kind: "folder", folderPath: "Tenders" } },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("Извещение о закупке");
  });

  it("tries the enabled rules only, in priority order", async () => {
    const { app } = harness({
      stored: companySettings({
        rules: [
          clientMailRuleSchema.parse({
            id: "off",
            name: "off",
            priority: 1,
            enabled: false,
            match: { from: "example.com" },
            decision: { kind: "folder", folderPath: "Tenders" },
          }),
          clientMailRuleSchema.parse({
            id: "on",
            name: "on",
            priority: 2,
            match: { from: "example.com" },
            decision: { kind: "folder", folderPath: "Tenders" },
          }),
        ],
      }),
    });
    const res = await request(app).post(PREVIEW_URL).send({ item: item() }).expect(200);
    expect(res.body.matched.map((entry: { id: string }) => entry.id)).toEqual(["on"]);
  });

  it("refuses a sample that is not a mail item", async () => {
    const { app } = harness();
    await request(app).post(PREVIEW_URL).send({ item: { subject: "no id" } }).expect(400);
  });

  it("refuses a member of another company", async () => {
    const { withActor } = harness();
    await request(withActor(outsider)).post(PREVIEW_URL).send({ item: item() }).expect(403);
  });
});

describe("myrmidon(EXTCASE-M): the batch a client's channel delivers", () => {
  it("processes a batch for the company the caller belongs to", async () => {
    const { app, deps } = harness();
    const spy = vi.spyOn(deps, "processBatch");
    const res = await request(app).post(BATCH_URL).send({ items: [item()], watermark: "cursor-1" }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith({ companyId: COMPANY_ID, items: [item()] });
  });

  it("refuses a batch for another company", async () => {
    const { withActor } = harness();
    await request(withActor(outsider)).post(BATCH_URL).send({ items: [item()] }).expect(403);
  });

  it("accepts a batch from an agent of that company", async () => {
    const { withActor } = harness();
    await request(withActor(agentActor)).post(BATCH_URL).send({ items: [item()] }).expect(200);
  });

  it("refuses more items than the contract allows", async () => {
    const { app } = harness();
    const many = Array.from({ length: 501 }, (_, index) => item({ messageId: `m-${index}` }));
    await request(app).post(BATCH_URL).send({ items: many }).expect(400);
  });

  it("refuses a batch carrying an unknown key", async () => {
    const { app } = harness();
    await request(app).post(BATCH_URL).send({ items: [item()], something: true }).expect(400);
  });

  it("reports a refused batch as the reason the operator needs, not as a board fault", async () => {
    const { app } = harness({
      processError: new ClientMailError(
        "mail_disabled",
        `the mail path of this company is not enabled; set general.clientMail.companies.${COMPANY_ID}.enabled`,
      ),
    });
    const res = await request(app).post(BATCH_URL).send({ items: [item()] }).expect(409);
    expect(res.body.error).toContain("general.clientMail.companies");
    expect(res.body.code).toBe("mail_disabled");
  });

  it("keeps an unexpected failure a board fault, without narrating it to the caller", async () => {
    const { app } = harness({ processError: new Error("a secret detail nobody should read") });
    const res = await request(app).post(BATCH_URL).send({ items: [item()] }).expect(500);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });
});