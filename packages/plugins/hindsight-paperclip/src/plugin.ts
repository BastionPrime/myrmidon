import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PaperclipPlugin } from "@paperclipai/plugin-sdk";
import { formatMemories, HindsightClient, type FetchLike } from "./client.js";
import { resolveBank } from "./bank.js";

export type { FetchLike };

/**
 * Fork of the upstream hindsight memory plugin worker.
 *
 * Differences from upstream 0.3.0, all in service of memory isolation:
 *
 * - Bank routing is per agent and closed by default. `deriveBankId`'s old
 *   modes (static shared bank, `paperclip::<company>::<agent>` derived id)
 *   are gone: an agent resolves through its card's
 *   `adapterConfig.hindsight.bankId` or the configuration's
 *   `bankByAgentId` map, and an unresolved agent writes and reads nothing.
 * - One resolution function (`resolveBank`) is used by all four paths:
 *   `issue.comment.created` retention, `agent.run.started` recall, and the
 *   `hindsight_recall` / `hindsight_retain` tools.
 * - Retain metadata carries `agentName` (the agent card's name), so memory
 *   can be classified by author without touching the board's database.
 *
 * The client transport is injectable for tests (`createHindsightPlugin({
 * fetchImpl })`); the worker entrypoint builds the plugin with the default.
 */

export interface HindsightPluginConfig {
  hindsightApiUrl: string;
  hindsightApiKeyRef?: string;
  recallBudget?: string;
  autoRetain?: boolean;
  bankByAgentId?: Record<string, string>;
  enabledAgentIds?: string[];
}

const CLOSED_AGENT_RETAIN_MESSAGE = "Retain skipped — agent not mapped to a bank";
const CLOSED_AGENT_RECALL_MESSAGE = "Recall skipped — agent not mapped to a bank";

interface PluginDeps {
  fetchImpl?: FetchLike;
}

async function getConfig(ctx: { config: { get(companyId?: string): Promise<Record<string, unknown>> } }, companyId?: string) {
  return (await ctx.config.get(companyId)) as HindsightPluginConfig & Record<string, unknown>;
}

function isAgentEnabled(config: HindsightPluginConfig, agentId: string | null | undefined): boolean {
  const allowlist = config.enabledAgentIds;
  if (!allowlist || allowlist.length === 0) return true;
  return !!agentId && allowlist.includes(agentId);
}

export function createHindsightPlugin(deps: PluginDeps = {}): PaperclipPlugin {
  return definePlugin({
    async setup(ctx) {
      ctx.logger.info("Hindsight memory plugin starting (per-agent bank routing)");

      const makeClient = async (config: HindsightPluginConfig) => {
        let token: string | undefined;
        if (config.hindsightApiKeyRef) {
          const resolved = await ctx.secrets.resolve(config.hindsightApiKeyRef);
          token = resolved ?? undefined;
        }
        return new HindsightClient(config.hindsightApiUrl, token, deps.fetchImpl);
      };

      const resolveForAgent = async (agentId: string, companyId: string) => {
        const config = await getConfig(ctx, companyId);
        return resolveBank({
          agentId,
          companyId,
          getAgent: (id, company) => ctx.agents.get(id, company),
          config,
        });
      };

      ctx.events.on("agent.run.started", async (event) => {
        const payload = (event.payload ?? {}) as { agentId?: string | null; runId?: string | null; issueId?: string | null };
        const agentId = payload.agentId;
        const runId = payload.runId;
        const issueId = payload.issueId;
        const companyId = event.companyId;
        if (!agentId || !companyId) return;
        const config = await getConfig(ctx, companyId);
        if (!isAgentEnabled(config, agentId)) return;
        if (!issueId) return;

        const resolution = await resolveForAgent(agentId, companyId);
        if (!resolution) {
          ctx.logger.warn(CLOSED_AGENT_RECALL_MESSAGE, { runId, agentId });
          return;
        }

        let issue: { title: string; description: string | null } | null = null;
        try {
          issue = await ctx.issues.get(issueId, companyId);
        } catch (err) {
          ctx.logger.warn("Failed to fetch issue for recall", { runId, issueId, error: String(err) });
          return;
        }
        if (!issue) return;
        const query = [issue.title, issue.description].filter(Boolean).join("\n");
        if (!query.trim()) return;

        try {
          const client = await makeClient(config);
          const response = await client.recall(resolution.bankId, query, config.recallBudget ?? "mid");
          const memories = formatMemories(response.results ?? []);
          if (memories) {
            await ctx.state.set(
              { scopeKind: "run", scopeId: runId ?? "", stateKey: "recalled-memories" },
              memories,
            );
            ctx.logger.info("Recalled memories for run", {
              runId,
              bankId: resolution.bankId,
              count: response.results.length,
            });
          }
        } catch (err) {
          ctx.logger.warn("Failed to recall memories on run start", { runId, error: String(err) });
        }
      });

      ctx.events.on("issue.comment.created", async (event) => {
        const config = await getConfig(ctx, event.companyId);
        if (config.autoRetain === false) return;
        const companyId = event.companyId;
        const issueId = event.entityId;
        const payload = (event.payload ?? {}) as { commentId?: string; agentId?: string | null; bodySnippet?: string };
        const commentId = payload.commentId;
        const payloadAgentId = payload.agentId ?? null;
        if (!issueId || !companyId || !commentId) return;

        let body = "";
        try {
          const comments = await ctx.issues.listComments(issueId, companyId);
          const match = comments.find((comment) => comment.id === commentId);
          if (match && typeof match.body === "string") body = match.body;
        } catch (err) {
          if (typeof payload.bodySnippet === "string") {
            body = payload.bodySnippet;
          } else {
            ctx.logger.warn("Failed to fetch comment body", { commentId, error: String(err) });
            return;
          }
        }
        if (!body.trim()) return;

        // A human comment retains into the ticket assignee's bank (the
        // upstream behavior, now routed through the same resolution).
        let bankAgentId = payloadAgentId;
        if (!bankAgentId) {
          try {
            const issue = await ctx.issues.get(issueId, companyId);
            bankAgentId = issue?.assigneeAgentId ?? null;
          } catch {
            bankAgentId = null;
          }
        }
        if (!bankAgentId) {
          ctx.logger.info("Skipping retain — no agent attribution available", { commentId, issueId });
          return;
        }
        if (!isAgentEnabled(config, bankAgentId)) {
          ctx.logger.debug("Skipping retain — agent not in enabled list", { commentId, agentId: bankAgentId });
          return;
        }

        const resolution = await resolveForAgent(bankAgentId, companyId);
        if (!resolution) {
          ctx.logger.warn(CLOSED_AGENT_RETAIN_MESSAGE, { commentId, agentId: bankAgentId });
          return;
        }

        try {
          const client = await makeClient(config);
          await client.retain(resolution.bankId, body, commentId, {
            agentId: bankAgentId,
            agentName: resolution.agentName,
            companyId,
            issueId,
            commentId,
          });
          ctx.logger.info("Retained comment to memory", { commentId, bankId: resolution.bankId });
        } catch (err) {
          ctx.logger.warn("Failed to retain comment", { commentId, error: String(err) });
        }
      });

      ctx.events.on("agent.run.finished", async (event) => {
        const payload = (event.payload ?? {}) as { agentId?: string | null; runId?: string | null };
        const config = await getConfig(ctx, event.companyId);
        if (!isAgentEnabled(config, payload.agentId)) return;
        ctx.logger.debug(
          "agent.run.finished received (no-op; retention handled by issue.comment.created)",
          { runId: payload.runId },
        );
      });

      ctx.tools.register(
        "hindsight_recall",
        {
          displayName: "Recall from Memory",
          description: "Search Hindsight long-term memory for context relevant to a query.",
          parametersSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", description: "What to search for" },
            },
          },
        },
        async (params, runCtx) => {
          const { query } = (params ?? {}) as { query?: string };
          const config = await getConfig(ctx, runCtx.companyId);
          if (!isAgentEnabled(config, runCtx.agentId)) {
            return { content: "No memories available for this agent." };
          }
          const resolution = await resolveForAgent(runCtx.agentId, runCtx.companyId);
          if (!resolution) {
            return { content: "No memories available for this agent." };
          }
          const cached = await ctx.state.get({
            scopeKind: "run",
            scopeId: runCtx.runId,
            stateKey: "recalled-memories",
          });
          if (cached && typeof cached === "string") {
            return { content: cached };
          }
          try {
            const client = await makeClient(config);
            const response = await client.recall(resolution.bankId, query ?? "", config.recallBudget ?? "mid");
            const memories = formatMemories(response.results ?? []);
            return { content: memories || "No relevant memories found." };
          } catch (err) {
            return { content: `Memory recall failed: ${String(err)}` };
          }
        },
      );

      ctx.tools.register(
        "hindsight_retain",
        {
          displayName: "Save to Memory",
          description: "Store important facts, decisions, or outcomes in Hindsight long-term memory for future runs.",
          parametersSchema: {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string", description: "The content to store in memory" },
            },
          },
        },
        async (params, runCtx) => {
          const { content } = (params ?? {}) as { content?: string };
          const config = await getConfig(ctx, runCtx.companyId);
          if (!isAgentEnabled(config, runCtx.agentId)) {
            return { content: CLOSED_AGENT_RETAIN_MESSAGE };
          }
          const resolution = await resolveForAgent(runCtx.agentId, runCtx.companyId);
          if (!resolution) {
            return { content: CLOSED_AGENT_RETAIN_MESSAGE };
          }
          try {
            const client = await makeClient(config);
            await client.retain(resolution.bankId, content ?? "", undefined, {
              agentId: runCtx.agentId,
              agentName: resolution.agentName,
              companyId: runCtx.companyId,
              runId: runCtx.runId,
            });
            return { content: "Memory saved." };
          } catch (err) {
            return { content: `Failed to save memory: ${String(err)}` };
          }
        },
      );

      ctx.logger.info("Hindsight memory plugin ready");
    },

    async onHealth() {
      return { status: "ok" };
    },

    async onValidateConfig(config) {
      const c = config as HindsightPluginConfig & Record<string, unknown>;
      if (!c.hindsightApiUrl?.trim()) {
        return { ok: false, errors: ["hindsightApiUrl is required"] };
      }
      try {
        const client = new HindsightClient(c.hindsightApiUrl, undefined, deps.fetchImpl);
        const healthy = await client.health();
        if (!healthy) {
          return {
            ok: false,
            errors: [`Cannot reach Hindsight at ${c.hindsightApiUrl}`],
          };
        }
      } catch (err) {
        return { ok: false, errors: [`Connection failed: ${String(err)}`] };
      }
      return { ok: true };
    },
  });
}
