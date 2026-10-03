// myrmidon(1.6-TG-PROACTIVITY-E): integration coverage for the head-bot
// proactivity policy (part E of TG-NOTIFY-SETTINGS, 1.6.1) against an
// embedded Postgres database. The fixtures follow
// server/src/__tests__/owner-telegram-delivery.myrmidon.test.ts (U2): a
// company with an owner board user, a task-owned agent, a Telegram endpoint
// and the owner's standing Telegram DM conversation.
//
// Covered acceptance criteria:
//   - default mode (only_on_owner_request): no proactive publications pass
//     the gate, U2 decision cards still pass;
//   - per-agent override from agent metadata wins over the company default;
//   - rarely: the first N proactive messages of the day are allowed, the
//     N+1st is bundled (not sent) — and lands in the bundle queue;
//   - the rarely counter resets on the UTC day boundary;
//   - U2 card bundling: several pending cards past the 5-minute window in
//     one conversation become ONE summary publication, every card is visible
//     in the summary, and the per-card callback action rows survive so each
//     card stays answerable.
//
// Neutral data only.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  authUsers,
  issues,
  instanceSettings,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import {
  applyProactivityGate,
  experimentalTelegramNotifySettingsReader,
  queueBundledProactivityText,
  readTelegramNotifyCounters,
  telegramNotifyDayBucket,
  type TelegramNotifySettingsReader,
} from "../myrmidon/telegram-notify/proactivity-policy.js";
import {
  sweepTelegramNotifyCardBundles,
  TELEGRAM_NOTIFY_BUNDLE_WINDOW_MS,
} from "../myrmidon/telegram-notify/card-bundler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

/** In-memory settings reader — the part-A area is mocked until it merges. */
function settingsReader(
  proactivity: { mode: "only_on_owner_request" | "rarely" | "normal"; rarelyMaxPerDay: number },
): TelegramNotifySettingsReader {
  return async () => ({ proactivity });
}

describeEmbeddedPostgres(
  "head-bot proactivity policy (TG-PROACTIVITY-E)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const secretsTmpDir = path.join(
      os.tmpdir(),
      `paperclip-tg-proactivity-${randomUUID()}`,
    );

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-tg-proactivity-",
      );
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterAll(async () => {
      await tempDb?.cleanup();
      rmSync(secretsTmpDir, { recursive: true, force: true });
    });

    async function seedFixture(agentMetadata: Record<string, unknown> = {}) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const boardUserId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Proactivity ${companyId.slice(0, 8)}`,
        issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      });
      await db
        .insert(authUsers)
        .values({
          id: boardUserId,
          name: "Owner User",
          email: `owner-${boardUserId.slice(0, 8)}@example.com`,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: boardUserId,
        status: "active",
        membershipRole: "operator",
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
        metadata: agentMetadata,
      });

      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const endpointId = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId,
        applicationKey: `chat:telegram:${endpointId}`,
        name: `telegram ${endpointId}`,
        type: "chat",
        status: "active",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId,
        applicationId,
        name: "telegram dm",
        uid: `chat-telegram-${endpointId}`,
        connectionPurpose: "channel",
        transport: "chat_sdk",
        status: "active",
        enabled: true,
      });
      await db.insert(chatEndpoints).values({
        id: endpointId,
        companyId,
        connectionId,
        provider: "telegram" as ChatProvider,
        publicId: randomUUID(),
        assignedAgentId: agentId,
        status: "active",
        capabilities: {
          threads: true,
          directMessages: true,
          nativeStreaming: false,
          messageEdits: true,
          messageDeletes: false,
          reactions: true,
          files: true,
          cards: true,
          actions: true,
          modals: false,
          slashCommands: true,
          ephemeralMessages: false,
          proactiveDirectMessages: true,
        },
      });

      const dmResourceId = randomUUID();
      await db.insert(chatEndpointResources).values({
        id: dmResourceId,
        companyId,
        endpointId,
        type: "direct_message",
        providerResourceId: `telegram-dm-${randomUUID()}`,
        label: "Telegram DM",
        enabled: true,
        availability: "available",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const [dmIssue] = await db
        .insert(issues)
        .values({
          companyId,
          title: "Telegram chat with agent-a",
          assigneeAgentId: agentId,
          conversationAgentId: agentId,
          conversationUserId: telegramConversationUserId(boardUserId),
          conversationState: "waiting",
          status: "in_review",
          createdByUserId: boardUserId,
        })
        .returning();
      const [conversation] = await db
        .insert(chatConversations)
        .values({
          companyId,
          endpointId,
          resourceId: dmResourceId,
          issueId: dmIssue.id,
          externalConversationId: `telegram-dm-${companyId.slice(0, 8)}`,
          externalThreadId: `telegram-dm-${companyId.slice(0, 8)}:thread`,
          sessionGeneration: 1,
          externalLabel: "Telegram DM",
          isDirectMessage: true,
          state: "active",
          lastActivityAt: new Date(),
        })
        .returning();

      return {
        companyId,
        agentId,
        endpointId,
        conversationId: conversation.id,
        dmIssue,
      };
    }

    async function resetCounters() {
      await db
        .update(instanceSettings)
        .set({ general: {} })
        .where(eq(instanceSettings.singletonKey, "default"));
    }

    it("default mode blocks proactive sends but passes U2 decision cards", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      const settings = settingsReader({
        mode: "only_on_owner_request",
        rarelyMaxPerDay: 3,
      });
      expect(
        await applyProactivityGate(db, settings, {
          agentId: fixture.agentId,
          idempotencyKey: "comment:1:2",
          isReplyToOwner: false,
        }),
      ).toEqual({ outcome: "block" });
      expect(
        await applyProactivityGate(db, settings, {
          agentId: fixture.agentId,
          idempotencyKey: `interaction:${randomUUID()}:${fixture.endpointId}`,
          isReplyToOwner: false,
        }),
      ).toEqual({ outcome: "allow" });
      // No counter is kept for a quiet company.
      expect(await readTelegramNotifyCounters(db)).toEqual({
        version: 1,
        day: "",
        sentByAgent: {},
        bundledByConversation: {},
      });
    });

    it("per-agent metadata override wins over the company default", async () => {
      await resetCounters();
      const quiet = settingsReader({
        mode: "only_on_owner_request",
        rarelyMaxPerDay: 3,
      });
      const fixture = await seedFixture({ mode: "normal" });
      expect(
        await applyProactivityGate(db, quiet, {
          agentId: fixture.agentId,
          idempotencyKey: "comment:1:2",
          isReplyToOwner: false,
        }),
      ).toEqual({ outcome: "allow" });
    });

    it("rarely: the N+1st proactive message of the day is bundled, not sent", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      const settings = settingsReader({
        mode: "rarely",
        rarelyMaxPerDay: 2,
      });
      const candidate = {
        agentId: fixture.agentId,
        idempotencyKey: "comment:1:2",
        isReplyToOwner: false,
      };
      expect(await applyProactivityGate(db, settings, candidate)).toEqual({
        outcome: "allow",
      });
      expect(await applyProactivityGate(db, settings, candidate)).toEqual({
        outcome: "allow",
      });
      // The N+1st is not sent — it lands in the bundle queue.
      expect(await applyProactivityGate(db, settings, candidate)).toEqual({
        outcome: "bundle",
      });
      const counters = await readTelegramNotifyCounters(db);
      expect(counters.sentByAgent[fixture.agentId]).toBe(2);
      expect(counters.day).toBe(telegramNotifyDayBucket());
    });

    it("the rarely counter resets on the UTC day boundary", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      const settings = settingsReader({
        mode: "rarely",
        rarelyMaxPerDay: 1,
      });
      const candidate = {
        agentId: fixture.agentId,
        idempotencyKey: "comment:1:2",
        isReplyToOwner: false,
      };
      expect(await applyProactivityGate(db, settings, candidate)).toEqual({
        outcome: "allow",
      });
      expect(await applyProactivityGate(db, settings, candidate)).toEqual({
        outcome: "bundle",
      });
      // A gate evaluated "tomorrow" starts from a fresh counter.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      expect(
        await applyProactivityGate(db, settings, candidate, { now: () => tomorrow }),
      ).toEqual({ outcome: "allow" });
    });

    it("U2 cards are not lost when bundled: each card stays visible and answerable", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      // Two pending interaction cards in one conversation, past the window.
      const interactionIds = [randomUUID(), randomUUID()];
      for (const interactionId of interactionIds) {
        await db.insert(chatPublications).values({
          companyId: fixture.companyId,
          endpointId: fixture.endpointId,
          conversationId: fixture.conversationId,
          issueId: fixture.dmIssue.id,
          idempotencyKey: `interaction:${interactionId}:${fixture.endpointId}`,
          payload: {
            version: 1,
            text: "Decision needed",
            interactionId,
            card: {
              kind: "confirmation",
              title: `Card ${interactionId.slice(0, 8)}`,
              body: "Proceed?",
              actions: [
                { type: "link", label: "Open", url: "https://paperclip.example/task" },
              ],
            },
          },
          state: "pending",
          createdAt: new Date(
            Date.now() - TELEGRAM_NOTIFY_BUNDLE_WINDOW_MS - 60_000,
          ),
        });
        // Per-card callback action rows exist exactly as the vendor writes them.
        await db.insert(chatActions).values({
          companyId: fixture.companyId,
          endpointId: fixture.endpointId,
          conversationId: fixture.conversationId,
          kind: "confirmation_response",
          providerActionId: `action-${interactionId}`,
          payload: { version: 1, interactionId, decision: "accept" },
          status: "issued",
        });
      }

      const bundles = await sweepTelegramNotifyCardBundles(db);
      expect(bundles).toBe(1);

      const [summary] = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(chatPublications.conversationId, fixture.conversationId),
          ),
        )
        .then((rows) => rows.filter((row) => row.idempotencyKey.startsWith("bundle:")));
      expect(summary).toBeTruthy();
      const summaryText = String(summary!.payload.text);
      // Every card is visible in the summary.
      for (const interactionId of interactionIds) {
        expect(summaryText).toContain(interactionId.slice(0, 8));
      }
      // The bundled originals are superseded, not lost: the callback actions
      // of each card survive, so each card is still answerable exactly.
      const survivingActions = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.companyId, fixture.companyId));
      expect(survivingActions).toHaveLength(2);
    });

    it("a single pending card inside the window is left alone", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      const interactionId = randomUUID();
      await db.insert(chatPublications).values({
        companyId: fixture.companyId,
        endpointId: fixture.endpointId,
        conversationId: fixture.conversationId,
        issueId: fixture.dmIssue.id,
        idempotencyKey: `interaction:${interactionId}:${fixture.endpointId}`,
        payload: {
          version: 1,
          text: "Decision needed",
          interactionId,
          card: { kind: "confirmation", title: "Card", body: "Proceed?" },
        },
        state: "pending",
        createdAt: new Date(
          Date.now() - TELEGRAM_NOTIFY_BUNDLE_WINDOW_MS - 60_000,
        ),
      });
      expect(await sweepTelegramNotifyCardBundles(db)).toBe(0);
      const [row] = await db
        .select()
        .from(chatPublications)
        .where(eq(chatPublications.idempotencyKey, `interaction:${interactionId}:${fixture.endpointId}`));
      expect(row!.state).toBe("pending");
    });

    it("bundled proactive texts drain into one digest publication per conversation", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      await queueBundledProactivityText(db, {
        companyId: fixture.companyId,
        endpointId: fixture.endpointId,
        conversationId: fixture.conversationId,
        issueId: fixture.dmIssue.id,
        text: "agent-a finished the first task",
      });
      await queueBundledProactivityText(db, {
        companyId: fixture.companyId,
        endpointId: fixture.endpointId,
        conversationId: fixture.conversationId,
        issueId: fixture.dmIssue.id,
        text: "agent-a hit a blocker on the second task",
      });
      const { sweepTelegramNotifyProactivityDigests } = await import(
        "../myrmidon/telegram-notify/sweep.js"
      );
      const digests = await sweepTelegramNotifyProactivityDigests(db);
      expect(digests).toBe(1);
      const [digest] = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(chatPublications.conversationId, fixture.conversationId),
          ),
        )
        .then((rows) => rows.filter((row) => row.idempotencyKey.startsWith("proactivity-digest:")));
      expect(String(digest!.payload.text)).toContain("2 items");
      expect(String(digest!.payload.text)).toContain("finished the first task");
      expect(String(digest!.payload.text)).toContain("hit a blocker");
      // The queue is drained.
      expect(
        (await readTelegramNotifyCounters(db)).bundledByConversation,
      ).toEqual({});
    });

    it("the settings reader parses the experimental telegramNotify area", async () => {
      await resetCounters();
      const fixture = await seedFixture();
      void fixture;
      await db
        .update(instanceSettings)
        .set({
          experimental: {
            telegramNotify: { proactivity: { mode: "rarely", rarelyMaxPerDay: 5 } },
          },
        })
        .where(eq(instanceSettings.singletonKey, "default"));
      const reader = experimentalTelegramNotifySettingsReader(db);
      expect(await reader()).toEqual({
        proactivity: { mode: "rarely", rarelyMaxPerDay: 5 },
      });
    });
  },
);
