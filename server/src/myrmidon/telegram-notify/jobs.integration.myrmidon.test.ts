// myrmidon(OPE-3789-B): DB-backed tests of the digest and escalation jobs.
// The company, chat endpoint and conversation fixtures follow the pattern of
// server/src/__tests__/chat-telegram-dm-conversation.myrmidon.test.ts (that
// file is not edited). The settings arrive through the injected port (part A
// is not merged; the tests mock its JSON contract), and the "send" is the
// chat_publications outbox row the vendor sweep would transport to the fake
// Telegram API — the same boundary the real path uses.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  runDigestForCompany,
  runEscalationsForCompany,
} from "./jobs.js";
import { readTelegramNotifyDocument } from "./store.js";
import { defaultTelegramNotifySettings, type TelegramNotifySettings } from "./settings.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

const secretsTmpDir = path.join(os.tmpdir(), `paperclip-telegram-notify-${randomUUID()}`);

beforeAll(async () => {
  mkdirSync(secretsTmpDir, { recursive: true });
  if (externalTestDatabaseUrl) {
    db = createDb(externalTestDatabaseUrl);
  } else {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-telegram-notify-");
    db = createDb(tempDb.connectionString);
  }
}, 30_000);

afterAll(async () => {
  await tempDb?.cleanup();
  rmSync(secretsTmpDir, { recursive: true, force: true });
});

interface Fixture {
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  chatId: string;
  agentId: string;
}

async function seedFixture(): Promise<Fixture> {
  const companyId = randomUUID();
  const endpointId = randomUUID();
  const agentId = randomUUID();
  const chatId = `-100${Math.floor(Math.random() * 100000)}`;
  await db.insert(companies).values({
    id: companyId,
    name: `Notify Test ${companyId.slice(0, 8)}`,
    issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "agent-a",
    role: "engineer",
    status: "idle",
    adapterType: "paperclip_runner",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  const [issue] = await db
    .insert(issues)
    .values({
      companyId,
      title: "Standing conversation for the digest target",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    })
    .returning();
  const [application] = await db
    .insert(toolApplications)
    .values({
      companyId,
      applicationKey: `notify-app-${randomUUID()}`,
      name: "Notify test app",
      type: "chat",
      status: "active",
    })
    .returning();
  const [connection] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application.id,
      name: "Notify test connection",
      uid: `notify-connection-${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
    })
    .returning();
  await db.insert(chatEndpoints).values({
    id: endpointId,
    companyId,
    connectionId: connection.id,
    provider: "telegram",
    publicId: `tg-${randomUUID().slice(0, 8)}`,
    publicationMode: "automatic",
    assignedAgentId: agentId,
    status: "active",
  });
  const [conversation] = await db
    .insert(chatConversations)
    .values({
      companyId,
      endpointId,
      issueId: issue.id,
      externalConversationId: chatId,
      externalThreadId: `telegram:${chatId}`,
      externalLabel: "digest target chat",
      isDirectMessage: false,
      state: "active",
    })
    .returning();
  return { companyId, endpointId, conversationId: conversation.id, issueId: issue.id, chatId, agentId };
}

/** Fake Telegram observation: the outbox rows this test inserts are what the
 *  vendor publication sweep would transport to the Telegram Bot API (the
 *  fake fetch in the vendor suites). Reading them is the test transport. */
async function sentPublications(companyId: string) {
  return db
    .select({ id: chatPublications.id, key: chatPublications.idempotencyKey, payload: chatPublications.payload })
    .from(chatPublications)
    .where(and(eq(chatPublications.companyId, companyId), eq(chatPublications.state, "pending")));
}

async function seedQuestion(fixture: Fixture, createdAt: Date, title = "Which database do we use?") {
  const [row] = await db
    .insert(issueThreadInteractions)
    .values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      kind: "ask_user_questions",
      status: "pending",
      title,
      createdByAgentId: fixture.agentId,
      payload: { version: 1, prompt: title, questions: [] },
    })
    .returning();
  await db
    .update(issueThreadInteractions)
    .set({ createdAt })
    .where(eq(issueThreadInteractions.id, row.id));
  return row;
}

interface Ports {
  listCompanyIds: () => Promise<string[]>;
  listFeed: (companyId: string) => Promise<{
    companyId: string;
    generatedAt: string;
    items: Array<{ sourceKind: string; severity: string; title: string | null; issueId: string | null; queues: string[] }>;
  }>;
  enqueuePublication: (input: { companyId: string; idempotencyKey: string; text: string; endpointId: string; conversationId: string; issueId: string }) => Promise<{ inserted: boolean }>;
  readSettings: (companyId: string) => Promise<TelegramNotifySettings>;
  now: () => Date;
}

/** The outbox insert with the fixture's real endpoint/conversation rows — the
 *  same chat_publications path the vendor sweep transports. */
function outboxEnqueue(fixture: Fixture) {
  return async (input: { companyId: string; idempotencyKey: string; text: string }) => {
    const [row] = await db
      .insert(chatPublications)
      .values({
        companyId: input.companyId,
        endpointId: fixture.endpointId,
        conversationId: fixture.conversationId,
        issueId: fixture.issueId,
        idempotencyKey: input.idempotencyKey,
        payload: { text: input.text },
        state: "pending",
      })
      .onConflictDoNothing()
      .returning();
    return { inserted: Boolean(row) };
  };
}

function makePorts(fixture: Fixture, settings: TelegramNotifySettings, now: () => Date, feedItems: Ports["listFeed"] extends (companyId: string) => Promise<{ items: infer T }> ? T : never): Ports {
  return {
    listCompanyIds: async () => [fixture.companyId],
    listFeed: async () => ({ companyId: fixture.companyId, generatedAt: "", items: feedItems }),
    enqueuePublication: outboxEnqueue(fixture),
    readSettings: async () => ({
      ...settings,
      digest: { ...settings.digest, chatId: fixture.chatId },
      escalations: { ...settings.escalations, chatId: fixture.chatId },
    }),
    now,
  };
}

describe("telegram notify jobs (DB-backed, part A settings mocked)", () => {
  it("sends nothing with the defaults (both jobs off)", async () => {
    const fixture = await seedFixture();
    await seedQuestion(fixture, new Date(Date.now() - 48 * 3_600_000));
    const ports = makePorts(fixture, defaultTelegramNotifySettings(), () => new Date("2026-10-03T09:30:00.000Z"), []);
    const digestResult = await runDigestForCompany(db, ports, fixture.companyId);
    const escalationResult = await runEscalationsForCompany(db, ports, fixture.companyId);
    // The red side of this test: without the enabled gate both jobs would
    // have enqueued a publication row.
    expect(digestResult).toEqual({ sent: false, reason: "disabled" });
    expect(escalationResult).toEqual({ resent: 0, skipped: 0 });
    expect(await sentPublications(fixture.companyId)).toHaveLength(0);
    expect((await readTelegramNotifyDocument(db, fixture.companyId)).lastDigestDate).toBeNull();
  });

  it("sends one digest with the configured sections when enabled", async () => {
    const fixture = await seedFixture();
    const settings = defaultTelegramNotifySettings();
    settings.digest.enabled = true;
    const ports = makePorts(
      fixture,
      settings,
      () => new Date("2026-10-03T09:30:00.000Z"),
      [
        { sourceKind: "decision", severity: "medium", title: "Choose the vendor", issueId: null, queues: [] },
        { sourceKind: "blocker_attention", severity: "high", title: "Waiting on a review", issueId: null, queues: [] },
      ],
    );
    const first = await runDigestForCompany(db, ports, fixture.companyId);
    expect(first).toEqual({ sent: true, reason: "sent" });
    const sent = await sentPublications(fixture.companyId);
    expect(sent).toHaveLength(1);
    const text = String((sent[0].payload as { text: string }).text);
    expect(text).toContain("Daily digest for 2026-10-03");
    for (const heading of ["Completed", "Blocked", "Needs your decision", "Budget"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Choose the vendor");
    expect(text).toContain("Waiting on a review");
    // One digest per day: a second pass the same day enqueues nothing.
    const second = await runDigestForCompany(db, ports, fixture.companyId);
    expect(second.reason).toBe("already_sent");
    expect(await sentPublications(fixture.companyId)).toHaveLength(1);
    expect((await readTelegramNotifyDocument(db, fixture.companyId)).lastDigestDate).toBe("2026-10-03");
  });

  it("does not send the digest before the configured time", async () => {
    const fixture = await seedFixture();
    const settings = defaultTelegramNotifySettings();
    settings.digest.enabled = true;
    const ports = makePorts(fixture, settings, () => new Date("2026-10-03T08:00:00.000Z"), []);
    expect(await runDigestForCompany(db, ports, fixture.companyId)).toEqual({ sent: false, reason: "not_due" });
    expect(await sentPublications(fixture.companyId)).toHaveLength(0);
  });

  it("re-sends an unanswered question only after the threshold, and not again immediately", async () => {
    const fixture = await seedFixture();
    const question = await seedQuestion(fixture, new Date("2026-10-01T09:00:00.000Z"));
    const settings = defaultTelegramNotifySettings();
    settings.escalations.enabled = true;
    settings.escalations.channel = "topic";
    settings.escalations.hours = 24;
    const enqueue = vi.fn(outboxEnqueue(fixture));
    const ports = makePorts(fixture, settings, () => new Date("2026-10-03T09:30:00.000Z"), []);
    ports.enqueuePublication = enqueue;
    // First pass: the question is 2 days old (over the 24h threshold) -> re-send.
    const first = await runEscalationsForCompany(db, ports, fixture.companyId);
    expect(first.resent).toBe(1);
    // Immediately after, a second pass does NOT re-send: the timer restarted.
    const second = await runEscalationsForCompany(db, ports, fixture.companyId);
    expect(second.resent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const state = await readTelegramNotifyDocument(db, fixture.companyId);
    expect(state.escalationSentAt[question.id]).toBe("2026-10-03T09:30:00.000Z");
    // A resolved question sends nothing on later passes.
    await db
      .update(issueThreadInteractions)
      .set({ status: "answered" })
      .where(eq(issueThreadInteractions.id, question.id));
    const third = await runEscalationsForCompany(db, ports, fixture.companyId);
    expect(third.resent).toBe(0);
    expect(third.skipped).toBe(0);
  });

  it("escalations channel 'none' never enqueues even when enabled", async () => {
    const fixture = await seedFixture();
    await seedQuestion(fixture, new Date("2026-10-01T09:00:00.000Z"));
    const settings = defaultTelegramNotifySettings();
    settings.escalations.enabled = true;
    settings.escalations.channel = "none";
    const ports = makePorts(fixture, settings, () => new Date("2026-10-03T09:30:00.000Z"), []);
    expect(await runEscalationsForCompany(db, ports, fixture.companyId)).toEqual({ resent: 0, skipped: 0 });
    expect(await sentPublications(fixture.companyId)).toHaveLength(0);
  });
});

// The store seam: our general key survives a vendor general write.
describe("telegram notify store across vendor settings writes", () => {
  it("keeps the job state key when the vendor service rewrites general", async () => {
    const fixture = await seedFixture();
    const { mutateTelegramNotifyDocument, preserveTelegramNotifyGeneralKey } = await import("./store.js");
    await mutateTelegramNotifyDocument(db, fixture.companyId, (current) => ({
      next: { ...current, lastDigestDate: "2026-10-02" },
      result: null,
    }));
    const { instanceSettingsService } = await import("../../services/instance-settings.js");
    await instanceSettingsService(db).updateGeneral({});
    const after = await readTelegramNotifyDocument(db, fixture.companyId);
    expect(after.lastDigestDate).toBe("2026-10-02");
    expect(preserveTelegramNotifyGeneralKey({ other: 1 })).toEqual({});
  });
});
