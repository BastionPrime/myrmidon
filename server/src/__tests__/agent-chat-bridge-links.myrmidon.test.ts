import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON } from "../services/heartbeat-run-summary.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres(
  "myrmidon(X8g) absolute board links in Telegram-bound agent replies",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    const boardBaseUrl = "https://board.example.com";

    beforeAll(async () => {
      process.env.PAPERCLIP_PUBLIC_URL = boardBaseUrl;
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-x8g-board-links-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterAll(async () => {
      if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
      await tempDb?.cleanup();
    });

    /**
     * A task with one bound endpoint, wired the same way the Telegram bridge
     * wires a chat-origin run: an inbound comment, a `chat_message_links` row
     * pointing at it, and a run whose `contextSnapshot.source` starts with
     * `chat:` and names that comment — the exact shape
     * `resolveChatOriginPublicationBindings` looks for.
     */
    async function seedChatOriginTask(provider: ChatProvider) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const otherIssueId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `X8g board links ${companyId}`,
        issuePrefix: `BL${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Chat bridge agent",
        role: "operator",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values([
        {
          id: issueId,
          companyId,
          title: "Standing chat conversation",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        },
        {
          id: otherIssueId,
          companyId,
          title: "Task the agent creates from the chat",
          status: "backlog",
          priority: "medium",
          assigneeAgentId: agentId,
        },
      ]);

      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const endpointId = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId,
        applicationKey: `chat:${provider}:${endpointId}`,
        name: `${provider} ${endpointId}`,
        type: "chat",
        status: "active",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId,
        applicationId,
        name: `${provider} channel`,
        uid: `chat-${provider}-${endpointId}`,
        connectionPurpose: "channel",
        transport: "chat_sdk",
        status: "active",
        enabled: true,
      });
      await db.insert(chatEndpoints).values({
        id: endpointId,
        companyId,
        connectionId,
        provider,
        publicId: randomUUID(),
        assignedAgentId: agentId,
        status: "active",
      });
      const [conversation] = await db
        .insert(chatConversations)
        .values({
          companyId,
          endpointId,
          issueId,
          externalConversationId: `${provider}-conversation`,
          externalThreadId: `${provider}:thread:${issueId}`,
          externalLabel: `${provider} thread`,
          isDirectMessage: true,
          state: "active",
        })
        .returning();

      const inboundComment = await issueService(db).addComment(
        issueId,
        "Create a task for the new task and tell me the link.",
        { userId: "board-linked-user" },
        { authorType: "user" },
      );
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: {
          issueId,
          source: `chat:${provider}`,
          commentId: inboundComment.id,
        },
      });
      await db.insert(chatMessageLinks).values({
        companyId,
        endpointId,
        conversationId: conversation.id,
        commentId: inboundComment.id,
        providerMessageId: `${provider}-inbound-1`,
        direction: "inbound",
      });

      return { companyId, agentId, issueId, otherIssueId, endpointId, runId };
    }

    it("absolutizes a relative board link only in the Telegram publication, leaving the board comment as written", async () => {
      const { agentId, issueId, otherIssueId, endpointId, runId } =
        await seedChatOriginTask("telegram");
      const relativeLink = `/issues/${otherIssueId}`;
      const replyBody = `Created [the new task](${relativeLink}) for you.`;

      const comment = await issueService(db).addComment(
        issueId,
        replyBody,
        { agentId, runId },
        {
          authorType: "agent",
          authorizationReason: CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
        },
      );

      const [storedComment] = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, comment.id));
      expect(storedComment?.body).toBe(replyBody);

      const [publication] = await db
        .select({ payload: chatPublications.payload })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.commentId, comment.id),
            eq(chatPublications.endpointId, endpointId),
          ),
        );
      expect(publication?.payload.text).toContain(
        `${boardBaseUrl}${relativeLink}`,
      );
      expect(publication?.payload.text).not.toContain(`](${relativeLink})`);
    });

    it("leaves the relative board link alone for a non-Telegram provider", async () => {
      const { agentId, issueId, otherIssueId, endpointId, runId } =
        await seedChatOriginTask("slack");
      const relativeLink = `/issues/${otherIssueId}`;
      const replyBody = `Created [the new task](${relativeLink}) for you.`;

      const comment = await issueService(db).addComment(
        issueId,
        replyBody,
        { agentId, runId },
        {
          authorType: "agent",
          authorizationReason: CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
        },
      );

      const [publication] = await db
        .select({ payload: chatPublications.payload })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.commentId, comment.id),
            eq(chatPublications.endpointId, endpointId),
          ),
        );
      // The vendor sanitizer already drops a relative href it cannot parse as
      // a URL, so the label survives without the link — same as before X8g.
      expect(publication?.payload.text).toContain("Created the new task for you.");
      expect(publication?.payload.text).not.toContain(boardBaseUrl);
    });
  },
);
