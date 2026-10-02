// myrmidon(U2): integration coverage for delivering an agent's question and
// confirmation cards to the owner's standing Telegram DM conversation (the X8b
// bridge) when the task the card belongs to has no chat-thread binding of its
// own. Fixtures follow server/src/__tests__/chat-interaction-publications.test.ts
// (vendor, not edited) plus the standing-conversation shape from
// server/src/myrmidon/agent-chat-bridge (X8a/X8b).
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { telegramConversationUserId } from "../myrmidon/agent-chat-bridge/identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres(
  "owner Telegram delivery of question and confirmation cards (U2)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const secretsTmpDir = path.join(
      os.tmpdir(),
      `paperclip-myrmidon-u2-owner-delivery-${randomUUID()}`,
    );

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
        secretsTmpDir,
        "master.key",
      );
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-u2-owner-delivery-",
      );
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterAll(async () => {
      await tempDb?.cleanup();
      if (previousKeyFile === undefined)
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      rmSync(secretsTmpDir, { recursive: true, force: true });
    });

    async function publicationsForInteraction(
      companyId: string,
      interactionId: string,
    ) {
      return db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              interactionId,
            ),
          ),
        );
    }

    /**
     * Seeds: a company with an owner board user; a task-owned agent; a
     * standing Telegram DM conversation issue for (agent, owner) with a live
     * chat_conversations binding; and a plain work task (responsible user =
     * owner, no conversation identity, no chat binding).
     */
    async function seedFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const boardUserId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `U2 delivery ${companyId.slice(0, 8)}`,
        issuePrefix: `U2${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
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
        name: "Bridget",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      // Telegram endpoint whose immutable assigned agent is the card author.
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

      // Standing Telegram DM conversation issue (X8b shape) + binding.
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
          title: "Telegram chat with Bridget",
          assigneeAgentId: agentId,
          conversationAgentId: agentId,
          conversationUserId: telegramConversationUserId(boardUserId),
          conversationState: "waiting",
          status: "in_review",
          createdByUserId: boardUserId,
        })
        .returning();
      await db.insert(chatConversations).values({
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
      });

      // The plain work task: responsible user = owner, no conversation
      // identity, no chat binding.
      const [workIssue] = await db
        .insert(issues)
        .values({
          companyId,
          title: "Owner question about the release",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: agentId,
          responsibleUserId: boardUserId,
          createdByUserId: boardUserId,
        })
        .returning();

      return { companyId, agentId, boardUserId, endpointId, dmIssue, workIssue };
    }

    it("delivers an agent question card on an unbound task to the owner's Telegram conversation", async () => {
      const fixture = await seedFixture();
      const question = {
        kind: "ask_user_questions" as const,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "deploy-window",
              prompt: "Which deploy window?",
              selectionMode: "single" as const,
              allowOther: false,
              options: [
                { id: "morning", label: "Morning" },
                { id: "evening", label: "Evening" },
              ],
            },
          ],
        },
      };

      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        question,
        { agentId: fixture.agentId },
      );

      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      expect(publications[0]!.conversationId).not.toBeNull();
      const [boundConversation] = await db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, fixture.companyId),
            inArray(
              chatConversations.id,
              publications.map((row) => row.conversationId),
            ),
          ),
        );
      expect(boundConversation?.issueId).toBe(fixture.dmIssue.id);
      expect(boundConversation?.isDirectMessage).toBe(true);
    });

    it("delivers a native telegram confirmation card on an unbound task to the owner's Telegram conversation", async () => {
      const fixture = await seedFixture();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "request_confirmation" as const,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            prompt: "Proceed with the deploy?",
            detailsMarkdown: "Deploy build to production.",
            acceptLabel: "Accept",
            rejectLabel: "Reject",
            allowDeclineReason: true,
          },
        },
        { agentId: fixture.agentId },
      );

      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toHaveLength(1);
      expect(publications[0]!.endpointId).toBe(fixture.endpointId);
      const payload = publications[0]!.payload as {
        card?: { kind?: string; actions?: Array<{ label?: string }> };
      };
      expect(payload.card?.kind).toBe("confirmation");
      expect(
        payload.card?.actions?.map((action) => action.label),
      ).toEqual(["Accept", "Reject"]);
    });

    it("keeps the card board-only when the owner has no standing Telegram conversation", async () => {
      const fixture = await seedFixture();
      // Retire the standing conversation: task stays owned but unbound.
      await db
        .update(chatConversations)
        .set({ state: "completed" })
        .where(
          and(
            eq(chatConversations.companyId, fixture.companyId),
            eq(chatConversations.endpointId, fixture.endpointId),
          ),
        );

      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [
              {
                id: "one",
                prompt: "Pick one",
                selectionMode: "single" as const,
                allowOther: false,
                options: [{ id: "a", label: "A" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );

      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toEqual([]);
    });

    it("does not deliver a card authored by another agent through this endpoint", async () => {
      const fixture = await seedFixture();
      const foreignAgentId = randomUUID();
      await db.insert(agents).values({
        id: foreignAgentId,
        companyId: fixture.companyId,
        name: "Outsider",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.workIssue.id, companyId: fixture.companyId },
        {
          kind: "ask_user_questions" as const,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [
              {
                id: "one",
                prompt: "Pick one",
                selectionMode: "single" as const,
                allowOther: false,
                options: [{ id: "a", label: "A" }],
              },
            ],
          },
        },
        { agentId: foreignAgentId },
      );

      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toEqual([]);
    });
  },
);
