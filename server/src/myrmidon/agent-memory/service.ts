// server/src/myrmidon/agent-memory/service.ts
//
// myrmidon(MEMORY-UI): the agent memory card's server logic.
//
// The card shows the memory bank the AGENT actually uses — resolved by the
// same rule the memory plugin fork applies (packages/plugins/hindsight-paperclip
// src/bank.ts): the card's adapterConfig.hindsight.bankId, else the plugin
// configuration's bankByAgentId map, else the agent is closed. The rule is
// reimplemented here (not imported): the plugin lives in its own package with
// a plugin-sdk dependency the server does not carry, and copying one pure
// function is cheaper than a workspace dependency. The plugin-config row is
// read through the vendor plugin registry service.
//
// Every mutating call (invalidate, clear, export) writes an activity log row,
// company-scoped, so deletion is auditable per the plan's acceptance criteria.

import { eq, and } from "drizzle-orm";
import { agents, pluginConfig, plugins, type Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/index.js";
import { createMemoryHindsightClient, type MemoryHindsightClient } from "./hindsight-client.js";
import { readMemoryUiSettings, type MemoryUiSettings } from "./settings.js";

const HINDSIGHT_PLUGIN_KEY = "paperclip-plugin-hindsight";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MEMORY_ACTION = "myrmidon.agent.memory";

/** The bank an agent's memory lives in, and where that answer came from. */
export interface MemoryBankResolution {
  bankId: string;
  source: "agent-card" | "plugin-config" | null;
}

export interface MemoryServiceDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  /** Company secret reader; the real wiring uses secretService. */
  readSecretValue(companyId: string, secretName: string): Promise<string | null>;
  /** Client factory, overridable in tests. */
  client(baseUrl: string, apiKey: string | undefined): MemoryHindsightClient;
  logActivity: typeof logActivity;
}

export interface MemoryCardStatus {
  enabled: boolean;
  bank: MemoryBankResolution | null;
  reason: string | null;
}

function readCardBankId(adapterConfig: Record<string, unknown> | null): string | null {
  if (!adapterConfig) return null;
  const hindsight = adapterConfig["hindsight"];
  if (hindsight === null || typeof hindsight !== "object" || Array.isArray(hindsight)) return null;
  const bankId = (hindsight as Record<string, unknown>)["bankId"];
  if (typeof bankId !== "string") return null;
  const trimmed = bankId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The plugin configuration's bankByAgentId map, read from plugin_config. */
async function readPluginConfigBank(db: Db, agentId: string): Promise<string | null> {
  const rows = await db
    .select({ configJson: pluginConfig.configJson })
    .from(pluginConfig)
    .innerJoin(plugins, eq(plugins.id, pluginConfig.pluginId))
    .where(and(eq(plugins.pluginKey, HINDSIGHT_PLUGIN_KEY)))
    .limit(5);
  for (const row of rows) {
    const map = row.configJson?.["bankByAgentId"];
    if (map === null || typeof map !== "object" || Array.isArray(map)) continue;
    const bankId = (map as Record<string, unknown>)[agentId];
    if (typeof bankId !== "string") continue;
    const trimmed = bankId.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Resolve the memory bank for one agent: the same rule the memory plugin
 * fork applies. The agent row is read here so a caller cannot name a bank the
 * agent does not actually use (acceptance: other banks unreachable).
 */
export async function resolveAgentMemoryBank(
  db: Db,
  input: { agentId: string; companyId: string },
): Promise<MemoryBankResolution | null> {
  if (!UUID_PATTERN.test(input.agentId)) return null;
  const rows = await db
    .select({ companyId: agents.companyId, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  const agent = rows[0];
  if (!agent || agent.companyId !== input.companyId) return null;
  const cardBank = readCardBankId(agent.adapterConfig ?? null);
  if (cardBank) return { bankId: cardBank, source: "agent-card" };
  const configBank = await readPluginConfigBank(db, input.agentId);
  if (configBank) return { bankId: configBank, source: "plugin-config" };
  return null;
}

export interface MemoryAuditActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
}

function memoryErrorToStatus(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 502;
}

export function agentMemoryService(deps: MemoryServiceDeps) {
  const env = deps.env ?? process.env;
  const settings = () => readMemoryUiSettings(env);

  /** Client for a company, or null while the section is off. */
  async function clientFor(companyId: string): Promise<MemoryHindsightClient | null> {
    const current = settings();
    if (!current.enabled || !current.baseUrl) return null;
    let apiKey: string | undefined;
    if (current.keySecret) {
      const value = await deps.readSecretValue(companyId, current.keySecret);
      apiKey = value ?? undefined;
    }
    return deps.client(current.baseUrl, apiKey);
  }

  async function status(agentId: string, companyId: string): Promise<MemoryCardStatus> {
    const current = settings();
    const bank = await resolveAgentMemoryBank(deps.db, { agentId, companyId });
    if (!current.enabled) {
      return { enabled: false, bank, reason: "not_enabled" };
    }
    if (!bank) {
      return { enabled: true, bank: null, reason: "no_bank" };
    }
    return { enabled: true, bank, reason: null };
  }

  async function list(
    agentId: string,
    companyId: string,
    opts: { limit?: number; offset?: number; state?: string } = {},
  ) {
    const bank = await resolveAgentMemoryBank(deps.db, { agentId, companyId });
    if (!bank) throw new MemoryUiError(404, "agent has no memory bank");
    const client = await clientFor(companyId);
    if (!client) throw new MemoryUiError(503, "agent memory is not enabled");
    return client.list(bank.bankId, opts);
  }

  async function exportBank(
    agentId: string,
    companyId: string,
    actor: MemoryAuditActor,
    opts: { limit?: number } = {},
  ) {
    const bank = await resolveAgentMemoryBank(deps.db, { agentId, companyId });
    if (!bank) throw new MemoryUiError(404, "agent has no memory bank");
    const client = await clientFor(companyId);
    if (!client) throw new MemoryUiError(503, "agent memory is not enabled");
    const limit = opts.limit ?? 500;
    const collected: HindsightExportItem[] = [];
    let offset = 0;
    // Page through the bank; the cap keeps a runaway bank from pinning the
    // request (the card says how many rows were truncated).
    const MAX_ROWS = 5000;
    let total = 0;
    for (;;) {
      const page = await client.list(bank.bankId, { limit: Math.min(limit, 500), offset });
      total = page.total;
      for (const item of page.items) {
        collected.push(toExportItem(item));
        if (collected.length >= MAX_ROWS) break;
      }
      offset += page.limit;
      if (collected.length >= MAX_ROWS || offset >= total || page.items.length === 0) break;
    }
    await audit(agentId, companyId, actor, "export", { bankId: bank.bankId, total, exported: collected.length });
    return { items: collected, total, truncated: total > collected.length };
  }

  async function invalidate(
    agentId: string,
    companyId: string,
    memoryId: string,
    reason: string,
    actor: MemoryAuditActor,
  ) {
    const bank = await resolveAgentMemoryBank(deps.db, { agentId, companyId });
    if (!bank) throw new MemoryUiError(404, "agent has no memory bank");
    const client = await clientFor(companyId);
    if (!client) throw new MemoryUiError(503, "agent memory is not enabled");
    try {
      await client.invalidate(bank.bankId, memoryId, reason);
    } catch (err) {
      throw new MemoryUiError(memoryErrorToStatus(err), readableError(err));
    }
    await audit(agentId, companyId, actor, "delete", { bankId: bank.bankId, memoryId, reason });
  }

  async function clearBank(agentId: string, companyId: string, actor: MemoryAuditActor) {
    const bank = await resolveAgentMemoryBank(deps.db, { agentId, companyId });
    if (!bank) throw new MemoryUiError(404, "agent has no memory bank");
    const client = await clientFor(companyId);
    if (!client) throw new MemoryUiError(503, "agent memory is not enabled");
    let result: { deletedCount: number | null };
    try {
      result = await client.clear(bank.bankId);
    } catch (err) {
      throw new MemoryUiError(memoryErrorToStatus(err), readableError(err));
    }
    await audit(agentId, companyId, actor, "clear", {
      bankId: bank.bankId,
      deletedCount: result.deletedCount,
    });
    return result;
  }

  async function audit(
    agentId: string,
    companyId: string,
    actor: MemoryAuditActor,
    action: string,
    details: Record<string, unknown>,
  ) {
    try {
      await deps.logActivity(deps.db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? agentId,
        action: `${MEMORY_ACTION}.${action}`,
        entityType: "agent",
        entityId: agentId,
        details,
      });
    } catch (err) {
      logger.error({ err, agentId, action }, "failed to write agent memory activity");
    }
  }

  return { status, list, exportBank, invalidate, clearBank };
}

/** The export row: no ids beyond the memory id, no metadata beyond tags. */
export interface HindsightExportItem {
  id: string;
  text: string;
  factType: string | null;
  state: string | null;
  occurredAt: string | null;
  createdAt: string | null;
  documentId: string | null;
  tags: string[];
}

function toExportItem(item: HindsightExportItem): HindsightExportItem {
  return item;
}

export class MemoryUiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MemoryUiError";
    this.status = status;
  }
}

function readableError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The real wiring: company secret store, global fetch. */
export function defaultAgentMemoryDeps(db: Db, env: NodeJS.ProcessEnv = process.env): MemoryServiceDeps {
  const secrets = secretService(db);
  return {
    db,
    env,
    async readSecretValue(companyId, secretName) {
      const row = await secrets.getByName(companyId, secretName);
      if (!row) return null;
      return secrets.resolveSecretValue(companyId, row.id, "latest");
    },
    client: (baseUrl, apiKey) => createMemoryHindsightClient(baseUrl, apiKey),
    logActivity,
  };
}
