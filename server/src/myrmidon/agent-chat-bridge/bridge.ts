// myrmidon(X8b): Telegram direct messages become a standing Agent Chat
// conversation instead of a fresh per-session task. This file holds every
// piece of that logic; `chat-channels.ts` only calls into it (see the
// `myrmidon(X8b)` call sites there). See docs/myrmidon/DIVERGENCE.md, track 4.
import { and, eq } from "drizzle-orm";
import {
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  issues,
  type Db,
} from "@paperclipai/db";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";

import { logger } from "../../middleware/logger.js";
import {
  publishActivity,
  type ActivityPublication,
  type logActivity,
} from "../../services/activity-log.js";
import { resumeConversationForReset } from "../../services/agent-conversations.js";
import { projectSafeChatPublication } from "../../services/chat-publication-projection.js";
import { safeChatTaskUrl } from "../../services/chat-task-url.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import type { issueService } from "../../services/issues.js";
import {
  parseBridgedCommand,
  runBridgedDirectMessageCommand,
} from "./commands/index.js";
import {
  conversationChannel,
  conversationOwnerUserId,
  telegramConversationUserId,
  type ConversationKey,
} from "./identity.js";
import { telegramDmConversationsEnabled } from "./settings.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EndpointRow = typeof chatEndpoints.$inferSelect;
type ConversationRow = typeof chatConversations.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/** Minimal shape `stageProviderEffect`'s payload needs; the real type stays private to chat-channels.ts. */
interface TelegramDmProviderEffectPayload {
  version: 1;
  authorizationMode?: "principal" | "safe_notice";
  effect: "thread_message";
  threadId: string;
  text: string;
  settleDelivery: boolean;
  resourceId?: string;
}

/** External dependencies the bridge needs from chat-channels.ts's closure. */
export interface TelegramDmBridgeDeps {
  issuesSvc: Pick<ReturnType<typeof issueService>, "getConversation" | "create">;
  stageTaskControlPublication: (
    tx: Db,
    input: {
      companyId: string;
      conversationId: string;
      endpointId: string;
      idempotencyKey: string;
      issueId: string;
      payload: SafeChatPublicationPayload;
      principalId: string;
    },
  ) => Promise<{ id: string }>;
  stageProviderEffect: (
    database: Db,
    input: {
      endpoint: EndpointRow;
      deliveryId?: string | null;
      conversationId?: string | null;
      principalId?: string | null;
      providerActionId: string;
      payload: TelegramDmProviderEffectPayload;
      runtimeContext: { credentialFingerprint: string; generation: number };
    },
  ) => Promise<{ id: string } | null>;
  processProviderEffect: (
    actionId: string,
    liveTarget?: { post: (...args: any[]) => any; postEphemeral?: (...args: any[]) => any },
  ) => Promise<"processed" | "pending" | "failed" | "delivery_unknown">;
  logActivity: typeof logActivity;
  publicBaseUrl: string | null;
  cancelRun?: (
    runId: string,
    reason: string,
    options: { errorCode?: string; resultJson?: Record<string, unknown> },
  ) => Promise<unknown>;
}

export interface TelegramDmBindingDecision {
  applies: boolean;
  detachExisting: boolean;
  releaseConversationId?: string;
  migratedFromIssueId?: string;
}

/** The old issue's identity: enough of it to classify and, if needed, link back to it. */
type ExistingIssueRef = ConversationKey & { id: string };

/**
 * Decides whether this inbound message belongs to a bridged Telegram DM
 * conversation, and whether the thread's current binding (if any) must be
 * released first. Read-only: callers apply `releaseConversationId` /
 * `existingConversation = null` themselves, under their own transaction.
 */
export async function decideTelegramDmBinding(
  db: Db,
  input: {
    endpoint: { provider: string; id: string; assignedAgentId: string };
    isDirectMessage: boolean;
    boardUserId: string | null;
    existingConversation: { id: string; state: string } | null;
    existingIssue: ExistingIssueRef | null;
  },
): Promise<TelegramDmBindingDecision> {
  const applies =
    input.endpoint.provider === "telegram" &&
    input.isDirectMessage &&
    input.boardUserId !== null &&
    telegramDmConversationsEnabled(input.endpoint.id) &&
    (await instanceSettingsService(db).getExperimental()).enableAgentChat === true;

  const boundToTelegramConversation =
    input.existingIssue !== null &&
    conversationChannel(input.existingIssue) === "telegram";

  if (applies) {
    const stillOpen =
      input.existingConversation !== null &&
      (input.existingConversation.state === "active" ||
        input.existingConversation.state === "waiting");
    const boundHere =
      boundToTelegramConversation &&
      conversationOwnerUserId(input.existingIssue) === input.boardUserId &&
      input.existingIssue!.conversationAgentId ===
        input.endpoint.assignedAgentId &&
      stillOpen;
    if (boundHere) return { applies: true, detachExisting: false };
    if (input.existingConversation) {
      return {
        applies: true,
        detachExisting: true,
        ...(stillOpen
          ? { releaseConversationId: input.existingConversation.id }
          : {}),
        ...(input.existingIssue &&
        conversationChannel(input.existingIssue) === null
          ? { migratedFromIssueId: input.existingIssue.id }
          : {}),
      };
    }
    return { applies: true, detachExisting: false };
  }

  if (boundToTelegramConversation && input.existingConversation) {
    return {
      applies: false,
      detachExisting: true,
      releaseConversationId: input.existingConversation.id,
    };
  }
  return { applies: false, detachExisting: false };
}

/** Gets or creates the standing Telegram conversation issue for (agent, boardUserId). */
export async function ensureTelegramDmConversation(
  tx: DbTransaction,
  deps: TelegramDmBridgeDeps,
  input: {
    companyId: string;
    agentId: string;
    endpointId: string;
    boardUserId: string;
  },
  publications: ActivityPublication[],
): Promise<IssueRow> {
  const conversationUserId = telegramConversationUserId(input.boardUserId);
  const existing = await deps.issuesSvc.getConversation(
    input.companyId,
    input.agentId,
    conversationUserId,
  );
  if (existing) return existing;
  const [agent] = await tx
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  const issue = await deps.issuesSvc.create(
    input.companyId,
    {
      title: `Telegram chat with ${agent?.name ?? "this agent"}`,
      assigneeAgentId: input.agentId,
      conversationAgentId: input.agentId,
      conversationUserId,
      conversationState: "waiting",
      status: "in_review",
      createdByUserId: input.boardUserId,
    },
    tx,
  );
  await deps.logActivity(
    tx as Db,
    {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.boardUserId,
      action: "issue.conversation_opened",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: input.agentId, channel: "telegram", endpointId: input.endpointId },
    },
    publications,
  );
  return issue;
}

/**
 * Gets or creates the `chat_conversations` row (a native-thread binding, one
 * generation) that ties this Telegram DM thread to the standing conversation
 * issue for (agent, boardUserId).
 */
export async function ensureTelegramDmBinding(
  tx: DbTransaction,
  deps: TelegramDmBridgeDeps,
  input: {
    endpoint: EndpointRow;
    resource: { id: string; label: string };
    thread: { id: string; channelId: string };
    providerUrl: string | null;
    boardUserId: string;
    current: ConversationRow | null;
    latestConversation: { sessionGeneration: number } | null;
  },
  publications: ActivityPublication[],
): Promise<{ conversation: ConversationRow; issue: IssueRow }> {
  const issue = await ensureTelegramDmConversation(
    tx,
    deps,
    {
      companyId: input.endpoint.companyId,
      agentId: input.endpoint.assignedAgentId,
      endpointId: input.endpoint.id,
      boardUserId: input.boardUserId,
    },
    publications,
  );
  if (
    input.current &&
    input.current.issueId === issue.id &&
    (input.current.state === "active" || input.current.state === "waiting")
  ) {
    return { conversation: input.current, issue };
  }
  if (
    input.current &&
    (input.current.state === "active" || input.current.state === "waiting")
  ) {
    await tx
      .update(chatConversations)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(chatConversations.id, input.current.id));
  }
  const sessionGeneration = (input.latestConversation?.sessionGeneration ?? 0) + 1;
  await tx
    .insert(chatConversations)
    .values({
      companyId: input.endpoint.companyId,
      endpointId: input.endpoint.id,
      resourceId: input.resource.id,
      issueId: issue.id,
      externalConversationId: input.thread.channelId,
      externalThreadId: input.thread.id,
      sessionGeneration,
      externalLabel: input.resource.label,
      providerUrl: input.providerUrl,
      isDirectMessage: true,
      state: "active",
      lastActivityAt: new Date(),
    })
    .onConflictDoNothing();
  const conversation = await tx
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.endpointId, input.endpoint.id),
        eq(chatConversations.externalConversationId, input.thread.channelId),
        eq(chatConversations.externalThreadId, input.thread.id),
        eq(chatConversations.sessionGeneration, sessionGeneration),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!conversation) {
    throw new Error("myrmidon(X8b): could not bind the Telegram DM conversation");
  }
  return { conversation, issue };
}

/**
 * Handles a bridged-DM message that may be an OpenClaw-style command.
 * Returns `done: true` when the whole inbound turn is finished (a `reply`
 * command already published its own answer); otherwise the caller continues
 * its normal comment/wakeup flow, optionally with an overridden body/notice
 * (a `message`-kind command result).
 */
export async function handleTelegramDmCommand(input: {
  db: Db;
  deps: TelegramDmBridgeDeps;
  endpoint: EndpointRow;
  resource: { id: string; label: string };
  thread: { id: string; channelId: string };
  providerUrl: string | null;
  boardUserId: string;
  deliveryId: string;
  principalId: string;
  text: string;
  current: ConversationRow | null;
  latestConversation: { sessionGeneration: number } | null;
}): Promise<{ done: true } | { done: false; body?: string; notice?: string }> {
  const parsed = parseBridgedCommand(input.text);
  if (!parsed) return { done: false };
  const commandPublications: ActivityPublication[] = [];
  const bound = await input.db.transaction((tx) =>
    ensureTelegramDmBinding(
      tx,
      input.deps,
      {
        endpoint: input.endpoint,
        resource: input.resource,
        thread: input.thread,
        providerUrl: input.providerUrl,
        boardUserId: input.boardUserId,
        current: input.current,
        latestConversation: input.latestConversation,
      },
      commandPublications,
    ),
  );
  for (const publication of commandPublications) publishActivity(publication);
  const result = await runBridgedDirectMessageCommand({
    db: input.db,
    companyId: input.endpoint.companyId,
    agentId: input.endpoint.assignedAgentId,
    endpointId: input.endpoint.id,
    deliveryId: input.deliveryId,
    boardUserId: input.boardUserId,
    conversationIssueId: bound.issue.id,
    text: input.text,
    publicBaseUrl: input.deps.publicBaseUrl,
    cancelRun:
      input.deps.cancelRun ??
      (async () => {
        throw new Error("chat_cancel_unavailable");
      }),
  });
  if (result === null) return { done: false };
  if (result.kind === "message") {
    return { done: false, body: result.body, notice: result.notice };
  }
  await input.db.transaction(async (tx) => {
    await tx
      .update(chatEndpoints)
      .set({ lastEventAt: new Date(), updatedAt: new Date() })
      .where(eq(chatEndpoints.id, input.endpoint.id));
    await tx
      .update(chatDeliveries)
      .set({
        conversationId: bound.conversation.id,
        state: "processed",
        processedAt: new Date(),
        redactedError: null,
        updatedAt: new Date(),
      })
      .where(eq(chatDeliveries.id, input.deliveryId));
    await input.deps.stageTaskControlPublication(tx as Db, {
      companyId: input.endpoint.companyId,
      endpointId: input.endpoint.id,
      conversationId: bound.conversation.id,
      issueId: bound.issue.id,
      idempotencyKey: `control:x8-${result.command}:${input.deliveryId}`,
      payload: projectSafeChatPublication({
        classification: "external",
        source: "task_control",
        text: result.text,
      }),
      principalId: input.principalId,
    });
  });
  return { done: true };
}

/**
 * Refuses an unlinked Telegram account writing to a bridged bot's DM, once
 * per account per UTC day. `stageProviderEffect`'s own unique
 * `providerActionId` is the dedupe key, so a repeat within the same day is a
 * silent no-op.
 */
export async function refuseUnlinkedTelegramDm(
  db: Db,
  deps: TelegramDmBridgeDeps,
  input: {
    endpoint: EndpointRow;
    thread: { id: string; post: (...args: any[]) => any };
    principalId: string;
    deliveryId: string | null;
    resourceId: string;
    runtimeContext: { credentialFingerprint: string; generation: number };
  },
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const effect = await deps.stageProviderEffect(db, {
      endpoint: input.endpoint,
      deliveryId: input.deliveryId,
      principalId: input.principalId,
      providerActionId: `provider_effect:x8-refusal:${input.endpoint.id}:${input.principalId}:${day}`,
      payload: {
        version: 1,
        authorizationMode: "safe_notice",
        effect: "thread_message",
        threadId: input.thread.id,
        text: "This bot is available only to members of this workspace. Ask an administrator to link your Telegram account.",
        settleDelivery: false,
        resourceId: input.resourceId,
      },
      runtimeContext: input.runtimeContext,
    });
    if (effect) await deps.processProviderEffect(effect.id, input.thread);
  } catch (error) {
    logger.warn(
      { endpointId: input.endpoint.id, error },
      "myrmidon(X8b): unlinked Telegram DM refusal notice failed",
    );
  }
}

/**
 * Post-commit follow-up for a bridged DM message: resumes a paused
 * conversation on `/new`, and sends the queued notice(s) — the migration
 * notice at most once per (endpoint, old issue).
 */
export async function afterTelegramDmMessage(input: {
  db: Db;
  deps: TelegramDmBridgeDeps;
  comment: Parameters<typeof resumeConversationForReset>[1];
  agentId: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  deliveryId: string;
  principalId: string;
  notice?: string;
  migratedFromIssueId?: string;
}): Promise<void> {
  if (input.comment.body.trim() === "/new") {
    await resumeConversationForReset(input.db, input.comment);
  }
  if (input.notice) {
    await input.db.transaction((tx) =>
      input.deps.stageTaskControlPublication(tx as Db, {
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        issueId: input.issueId,
        idempotencyKey: `control:x8-notice:${input.deliveryId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "task_control",
          text: input.notice!,
        }),
        principalId: input.principalId,
      }),
    );
  }
  if (input.migratedFromIssueId) {
    const [agent] = await input.db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
    const link = safeChatTaskUrl(input.deps.publicBaseUrl, input.migratedFromIssueId);
    const text = `This chat is now a standing conversation with ${agent?.name ?? "this agent"}. Earlier tasks stay on the board${link ? `: ${link}` : "."}`;
    await input.db.transaction((tx) =>
      input.deps.stageTaskControlPublication(tx as Db, {
        companyId: input.companyId,
        endpointId: input.endpointId,
        conversationId: input.conversationId,
        issueId: input.issueId,
        idempotencyKey: `control:x8-migrated:${input.deliveryId}`,
        payload: projectSafeChatPublication({
          classification: "external",
          source: "task_control",
          text,
        }),
        principalId: input.principalId,
      }),
    );
  }
}
