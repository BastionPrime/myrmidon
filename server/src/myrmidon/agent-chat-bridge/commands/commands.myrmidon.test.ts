// myrmidon(X8c): OpenClaw-style commands in a bridged Telegram direct
// message conversation. Red on pre-X8c main: X8a's `runBridgedDirectMessageCommand`
// is a `/new`/`/reset`-only stand-in, and `./context.js`, `./help.js`,
// `./models.js`, `./overrides.js`, `./status.js`, `./stop.js` do not exist there.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { telegramConversationUserId } from "../identity.js";
import {
  TELEGRAM_DM_COMMANDS,
  parseBridgedCommand,
  runBridgedDirectMessageCommand,
  type BridgedCommandInput,
} from "./index.js";
import { applyChatAdapterOverride } from "./overrides.js";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("bridged Telegram DM commands (X8c)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let gatewayAgentId: string;
  let sentinelAgentId: string;

  beforeAll(async () => {
    process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
      hermes_local: [{ id: "model-c" }],
    });

    database = await startEmbeddedPostgresTestDatabase("myrmidon-x8c-commands-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    gatewayAgentId = randomUUID();
    sentinelAgentId = randomUUID();

    await db
      .insert(authUsers)
      .values({
        id: "local-board",
        name: "Local Board",
        email: "local@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(companies).values({
      id: companyId,
      name: "X8c Test Co",
      issuePrefix: "X8C",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent A",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: { model: "model-a", models: { fallbacks: ["model-b"] } },
    });
    await db.insert(agents).values({
      id: gatewayAgentId,
      companyId,
      name: "Agent B (gateway)",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    });
    // A card whose own model/fallbacks are the adapter's "let it decide"
    // sentinels (ADAPTER_SPECIAL_MODEL_VALUES) rather than real model names.
    await db.insert(agents).values({
      id: sentinelAgentId,
      companyId,
      name: "Agent C (sentinel card)",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: { model: "default", models: { fallbacks: ["auto", "model-b"] } },
    });
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function createTelegramConversation(
    options: {
      agentId?: string;
      boardUserId?: string;
      assigneeAdapterOverrides?: Record<string, unknown> | null;
      executionRunId?: string | null;
    } = {},
  ) {
    const conversationAgentId = options.agentId ?? agentId;
    const boardUserId = options.boardUserId ?? randomUUID();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Telegram chat",
        conversationAgentId,
        conversationUserId: telegramConversationUserId(boardUserId),
        assigneeAgentId: conversationAgentId,
        status: "in_review",
        conversationState: "waiting",
        assigneeAdapterOverrides: options.assigneeAdapterOverrides ?? null,
        executionRunId: options.executionRunId ?? null,
      })
      .returning();
    return { issue: issue!, boardUserId, agentId: conversationAgentId };
  }

  async function createWebConversation(boardUserId = randomUUID()) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Web chat",
        conversationAgentId: agentId,
        conversationUserId: boardUserId,
        assigneeAgentId: agentId,
        status: "in_review",
        conversationState: "waiting",
      })
      .returning();
    return { issue: issue!, boardUserId };
  }

  function noopCancelRun(): BridgedCommandInput["cancelRun"] {
    return async () => ({});
  }

  function baseInput(
    overrides: Partial<BridgedCommandInput> & Pick<BridgedCommandInput, "conversationIssueId" | "boardUserId" | "text">,
  ): BridgedCommandInput {
    return {
      db,
      companyId,
      agentId,
      endpointId: "endpoint-a",
      deliveryId: randomUUID(),
      publicBaseUrl: null,
      cancelRun: noopCancelRun(),
      ...overrides,
    };
  }

  async function readOverrides(issueId: string) {
    const [row] = await db
      .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, issueId));
    return (row?.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null;
  }

  async function hasSessionRow(issueId: string, forAgentId = agentId) {
    const rows = await db
      .select({ id: agentTaskSessions.id })
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, forAgentId), eq(agentTaskSessions.taskKey, issueId)));
    return rows.length > 0;
  }

  it("1. /model lists the card model, its fallback and the discovered model, with the current one identified", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model" }),
    );
    expect(result?.kind).toBe("reply");
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("Модель: model-a (по умолчанию у агента)");
    expect(text).toMatch(/1\)\s*model-a/);
    expect(text).toMatch(/2\)\s*model-b/);
    expect(text).toMatch(/3\)\s*model-c/);
  });

  it("1b. /model and /status never show the adapter's own 'default'/'auto' sentinels as a chosen model", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: sentinelAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, agentId: sentinelAgentId, text: "/model" }),
    );
    expect(result?.kind).toBe("reply");
    const text = (result as { kind: "reply"; text: string }).text;
    // Neither the card's "default" model nor its "auto" fallback is a real
    // choice; only model-b (a real fallback) and model-c (discovered) are.
    expect(text).toContain("Модель: по умолчанию у адаптера (по умолчанию у адаптера)");
    expect(text).not.toMatch(/\)\s*default\b/i);
    expect(text).not.toMatch(/\)\s*auto\b/i);
    expect(text).toMatch(/1\)\s*model-b/);
    expect(text).toMatch(/2\)\s*model-c/);

    const status = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, agentId: sentinelAgentId, text: "/status" }),
    );
    const statusText = (status as { kind: "reply"; text: string }).text;
    expect(statusText).toContain("Модель: по умолчанию у адаптера (по умолчанию у адаптера)");
  });

  it("2. /model model-b sets the override, keeps other override keys, drops the session and logs the change", async () => {
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "hermes_local",
      taskKey: "placeholder",
    });
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { adapterConfig: { effort: "high" }, useProjectWorkspace: true },
    });
    await db.update(agentTaskSessions).set({ taskKey: issue.id }).where(eq(agentTaskSessions.taskKey, "placeholder"));
    expect(await hasSessionRow(issue.id)).toBe(true);

    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model model-b" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      text: "Модель для этого чата: model-b. Следующий ответ начнёт новую сессию модели с недавней историей этого чата.",
    });

    const overrides = await readOverrides(issue.id);
    expect(overrides).toEqual({
      adapterConfig: { effort: "high", model: "model-b" },
      useProjectWorkspace: true,
    });
    expect(await hasSessionRow(issue.id)).toBe(false);

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.updated")));
    expect(activity).toBeTruthy();
    expect(activity!.actorType).toBe("user");
    expect(activity!.actorId).toBe(boardUserId);
    expect(activity!.details).toMatchObject({
      source: "chat:telegram",
      conversationOverride: { key: "model", value: "model-b" },
    });
  });

  it("3. /model accepts a 1-based index and is case-insensitive on names", async () => {
    const byIndex = await createTelegramConversation();
    const byIndexResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: byIndex.issue.id, boardUserId: byIndex.boardUserId, text: "/model 3" }),
    );
    expect(byIndexResult).toMatchObject({ kind: "reply", text: expect.stringContaining("Модель для этого чата: model-c.") });

    const byName = await createTelegramConversation();
    const byNameResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: byName.issue.id, boardUserId: byName.boardUserId, text: "/model MODEL-B" }),
    );
    expect(byNameResult).toMatchObject({ kind: "reply", text: expect.stringContaining("Модель для этого чата: model-b.") });
  });

  it("4. /model nope is rejected and changes nothing", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model nope" }),
    );
    expect(result).toMatchObject({ kind: "reply", command: "model", text: expect.stringContaining('Неизвестная модель «nope».') });
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("5. /model is refused while this conversation has a run in progress", async () => {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running" })
      .returning();
    const { issue, boardUserId } = await createTelegramConversation({ executionRunId: run!.id });

    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model model-b" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      text: "Сейчас идёт ответ. Попробуйте после него или отправьте /stop.",
    });
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("5b. applyChatAdapterOverride re-checks turnInProgress at write time (review round 2, minor)", async () => {
    // Reproduces the narrow window between a command handler's earlier
    // turnInProgress read (loadBridgedCommandContext, before argument
    // resolution) and applyChatAdapterOverride's own write: a run that starts
    // in between must still block a /model or /think write, so the check is
    // repeated here, inside the row lock, against a freshly read
    // executionRunId/heartbeat_runs state — not just trusted from earlier.
    const { issue, boardUserId } = await createTelegramConversation();
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "hermes_local", taskKey: issue.id });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });

    const refused = await applyChatAdapterOverride({
      db,
      companyId,
      conversationAgentId: agentId,
      issueId: issue.id,
      boardUserId,
      key: "model",
      value: "model-b",
      refuseIfTurnInProgress: true,
    });
    expect(refused).toEqual({ applied: false });
    expect(await readOverrides(issue.id)).toBeNull();
    // The refusal must not touch the session either — only a successful
    // apply resets it.
    expect(await hasSessionRow(issue.id)).toBe(true);

    // /new's own call passes refuseIfTurnInProgress: false and must still
    // apply — it targets the fresh session it is about to start, not
    // whatever is currently running (index.ts's handleNewCommand).
    const applied = await applyChatAdapterOverride({
      db,
      companyId,
      conversationAgentId: agentId,
      issueId: issue.id,
      boardUserId,
      key: "model",
      value: "model-b",
      refuseIfTurnInProgress: false,
    });
    expect(applied).toEqual({ applied: true });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { model: "model-b" } });
    expect(await hasSessionRow(issue.id)).toBe(false);
  });

  it("6. /model default clears the override, dropping an empty adapterConfig entirely", async () => {
    const { issue, boardUserId } = await createTelegramConversation({
      assigneeAdapterOverrides: { adapterConfig: { model: "model-b" } },
    });
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/model default" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      text: "Модель для этого чата: по умолчанию у агента (model-a).",
    });
    expect(await readOverrides(issue.id)).toBeNull();
  });

  it("7. /model is not available for hermes_gateway (until G4 lands)", async () => {
    const { issue, boardUserId } = await createTelegramConversation({ agentId: gatewayAgentId });
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, agentId: gatewayAgentId, text: "/model" }),
    );
    expect(result).toEqual({
      kind: "reply",
      command: "model",
      text: "Смена модели недоступна для этого агента.",
    });
  });

  it("8. /think sets a known effort level and rejects an unknown one", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const high = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/think high" }),
    );
    expect(high).toEqual({
      kind: "reply",
      command: "think",
      text: "Рассуждения для этого чата: high. Следующий ответ начнёт новую сессию модели с недавней историей этого чата.",
    });
    expect(await readOverrides(issue.id)).toEqual({ adapterConfig: { effort: "high" } });

    const bogus = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/think bogus" }),
    );
    expect(bogus).toMatchObject({
      kind: "reply",
      command: "think",
      text: expect.stringContaining('Неизвестная глубина рассуждений «bogus».'),
    });
  });

  it("9. /new <model> sets the model and starts a new session; /reset resets without one", async () => {
    const withModel = await createTelegramConversation();
    const withModelResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: withModel.issue.id, boardUserId: withModel.boardUserId, text: "/new model-b" }),
    );
    expect(withModelResult).toEqual({
      kind: "message",
      body: "/new",
      notice: "Новая сессия начата с моделью model-b. История остаётся на доске.",
    });
    expect(await readOverrides(withModel.issue.id)).toEqual({ adapterConfig: { model: "model-b" } });

    const reset = await createTelegramConversation();
    const resetResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: reset.issue.id, boardUserId: reset.boardUserId, text: "/reset" }),
    );
    expect(resetResult).toEqual({
      kind: "message",
      body: "/new",
      notice: "Новая сессия начата. История остаётся на доске.",
    });
  });

  it("10. /stop cancels only this conversation's own queued and running runs", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const other = await createTelegramConversation();

    const [queued] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "queued", contextSnapshot: { issueId: issue.id } })
      .returning();
    const [running] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: { issueId: issue.id } })
      .returning();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: other.issue.id },
    });

    const cancelled: Array<{
      runId: string;
      reason: string;
      options: { errorCode?: string; resultJson?: Record<string, unknown> };
    }> = [];
    const cancelRun: BridgedCommandInput["cancelRun"] = async (runId, reason, options) => {
      cancelled.push({ runId, reason, options });
      return {};
    };
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/stop", cancelRun }),
    );
    expect(result).toEqual({ kind: "reply", command: "stop", text: "Останавливаю текущий ответ." });
    expect(cancelled.map((c) => c.runId).sort()).toEqual([queued!.id, running!.id].sort());
    for (const call of cancelled) {
      expect(call.options).toMatchObject({
        errorCode: "chat_session_stopped",
        resultJson: { cancelledByActorType: "user", cancelledByUserId: boardUserId },
      });
    }

    const idle = await createTelegramConversation();
    const idleResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: idle.issue.id, boardUserId: idle.boardUserId, text: "/stop" }),
    );
    expect(idleResult).toEqual({ kind: "reply", command: "stop", text: "Сейчас ничего не выполняется." });
  });

  it("11. /status reports model source and session state without leaking any id", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/status" }),
    );
    expect(result?.kind).toBe("reply");
    const text = (result as { kind: "reply"; text: string }).text;
    expect(text).toContain("Модель: model-a (по умолчанию у агента)");
    expect(text).toContain("Сессия: #1, сессия модели начнётся заново со следующим ответом");
    expect(text).toContain("Сейчас: простаивает");
    expect(text).not.toMatch(UUID_PATTERN);
  });

  it("12. /help lists every command; /foo is unknown; /home/x is not a command", async () => {
    const { issue, boardUserId } = await createTelegramConversation();
    const help = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/help" }),
    );
    expect(help?.kind).toBe("reply");
    const helpText = (help as { kind: "reply"; text: string }).text;
    for (const command of TELEGRAM_DM_COMMANDS) {
      expect(helpText).toContain(`/${command.command}`);
    }

    const unknown = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/foo" }),
    );
    expect(unknown).toEqual({
      kind: "reply",
      // myrmidon(X8c): `command` is a fixed literal here, not the chat's
      // own text — see the "12b" case below for why.
      command: "unknown",
      text: "Неизвестная команда /foo. Список команд — /help.",
    });

    expect(parseBridgedCommand("/home/x")).toBeNull();
    const notACommand = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/home/x" }),
    );
    expect(notACommand).toBeNull();
  });

  it("12b. an unknown command's name never reaches the `command` result field, and is capped in reply text", async () => {
    const { issue, boardUserId } = await createTelegramConversation();

    // COMMAND_PATTERN allows digits and underscores in a command name, but
    // the X8 contract requires `command` to match [a-z-]+ (it feeds a
    // publication key); a fixed literal is used instead of echoing chat text.
    const withDigits = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: "/aaa_123" }),
    );
    expect(withDigits).toEqual({
      kind: "reply",
      command: "unknown",
      text: "Неизвестная команда /aaa_123. Список команд — /help.",
    });

    // COMMAND_PATTERN also does not bound the command name's length; the
    // reply must still stay well short of a single Telegram message.
    const longName = "a".repeat(500);
    const longResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId, text: `/${longName}` }),
    );
    expect(longResult?.kind).toBe("reply");
    expect((longResult as { command: string }).command).toBe("unknown");
    const longText = (longResult as { kind: "reply"; text: string }).text;
    expect(longText.length).toBeLessThan(150);
    expect(longText).toContain("…");
  });

  it("13. commands refuse a web conversation and another person's Telegram conversation, writing nothing", async () => {
    const web = await createWebConversation();
    const webResult = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: web.issue.id, boardUserId: web.boardUserId, text: "/model" }),
    );
    // myrmidon(X8c): `command` is a fixed literal ("not-available"), not the
    // command that was typed — see the "13b" case below for why.
    expect(webResult).toEqual({ kind: "reply", command: "not-available", text: "Этот чат недоступен." });

    const { issue, boardUserId } = await createTelegramConversation();
    const impersonating = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: issue.id, boardUserId: randomUUID(), text: "/model model-b" }),
    );
    expect(impersonating).toEqual({ kind: "reply", command: "not-available", text: "Этот чат недоступен." });
    expect(await readOverrides(issue.id)).toBeNull();

    const activityForIssue = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issue.id)));
    expect(activityForIssue).toHaveLength(0);
  });

  it("13b. an unavailable chat's `command` result field ignores the (possibly malformed) command text", async () => {
    const web = await createWebConversation();
    const result = await runBridgedDirectMessageCommand(
      baseInput({ conversationIssueId: web.issue.id, boardUserId: web.boardUserId, text: "/aaa_123 with args" }),
    );
    expect(result).toEqual({ kind: "reply", command: "not-available", text: "Этот чат недоступен." });
  });
});
