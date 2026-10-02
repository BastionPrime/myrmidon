import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  AGENT_KEY_SECRET_PREFIX,
  agentKeySecretName,
  readGatewayKeySettings,
  type GatewayKeySettings,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { secretService } from "../../services/index.js";

/**
 * myrmidon(M2-B): one LLM gateway virtual key per agent, held in the company
 * secret store.
 *
 * Why a key per agent, and not one key for the company: M2-A attributes spend
 * by hashing the value a bot authenticated with, so "spend per agent" is only
 * true when every agent authenticates with its OWN key. A single company-wide
 * key makes every agent's rows indistinguishable.
 *
 * Ownership rules this module keeps:
 *
 *  - The key value lives in exactly two places: the company secret store (the
 *    source of truth, reached through the secrets service) and the gateway's
 *    own key table. The board keeps no copy and no cache — the value is
 *    resolved on demand, written to the gateway once, and never logged. Only
 *    its sha256 leaves this module, which is also the form the gateway's spend
 *    ledger stores.
 *  - The secret name is derived from the agent id, so nothing collides and a
 *    rotation touches one secret and one gateway key. A second key for the
 *    same agent is refused rather than written over.
 *  - An agent may read its own key's state, never another agent's and never
 *    the admin key. The gateway is reached with a SEPARATE admin secret, so an
 *    agent's key never needs key-management rights.
 *
 * The gateway is called over the REST API M2-A already reads: `/key/generate`
 * and `/key/update` take the value to install, and the gateway stores its
 * sha256 — the same `hash_token` M2-A matches against the spend ledger.
 */

export interface AgentGatewayKeyDeps {
  db: Db;
  /** Resolves a company secret by name and returns its value; null when absent. */
  readSecretValue(companyId: string, secretName: string): Promise<string | null>;
  /** Finds a company secret id by name; null when absent. */
  findSecretId(companyId: string, secretName: string): Promise<string | null>;
  /** Creates a company secret; returns its id. */
  createSecret(input: {
    companyId: string;
    name: string;
    value: string;
    description: string;
  }): Promise<{ id: string }>;
  /** Rotates a company secret to a new value. */
  rotateSecret(secretId: string, value: string): Promise<void>;
  /** The key-management port of the gateway, built from the admin key. */
  gateway(input: { baseUrl: string; adminKey: string }): GatewayKeyAdminPort;
  env?: NodeJS.ProcessEnv;
  log?: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}

/** The key-management surface of the gateway this module uses. */
export interface GatewayKeyAdminPort {
  /** Installs a key under an alias. The gateway stores its sha256. */
  createKey(input: { alias: string; value: string }): Promise<void>;
  /** Replaces the value behind an alias. Returns false when the alias is unknown. */
  rotateKey(input: { alias: string; value: string }): Promise<boolean>;
  /** Removes a key by alias. */
  deleteKey(input: { alias: string }): Promise<void>;
}

/** What a card's gateway key looks like to a caller: never the value itself. */
export interface AgentGatewayKeyView {
  agentId: string;
  /** The secret-store name that carries the key. */
  secretName: string;
  /** True when the store holds a value for it. */
  present: boolean;
  /** sha256 of the value — the only form the value is reported in. */
  valueHash: string | null;
  /** Whether this instance may manage gateway keys at all. */
  canManageKeys: boolean;
}

export interface AgentGatewayKeyInput {
  companyId: string;
  agentId: string;
}

/**
 * Creates an agent's gateway key: the value goes to the gateway first, then to
 * the store. That order matters on failure — if the gateway refuses, the store
 * is untouched and the agent keeps working on whatever it already had, instead
 * of the store naming a key the gateway never accepted.
 *
 * The value is returned to the caller exactly once, on creation, and never
 * persisted by the board; the caller (a board member) hands it to nobody — the
 * bot reads it from the store through its profile. An already-present key is a
 * conflict, not an overwrite: a silent overwrite would cut a working bot off.
 */
export async function createAgentGatewayKey(
  deps: AgentGatewayKeyDeps,
  input: AgentGatewayKeyInput,
): Promise<{ view: AgentGatewayKeyView; value: string }> {
  const settings = requireKeyManagement(deps.env ?? process.env);
  const agent = await loadAgent(deps.db, input);
  const secretName = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });

  const existing = await deps.readSecretValue(input.companyId, secretName);
  if (existing) {
    throw conflict(
      `agent "${agent.name}" already has a gateway key in "${secretName}"; rotate it instead`,
      { code: "gateway_key_exists", secretName },
    );
  }

  const adminKey = await requireAdminKey(deps, input.companyId, settings);
  const value = generateGatewayKeyValue();
  await deps.gateway({ baseUrl: settings.baseUrl!, adminKey }).createKey({ alias: secretName, value });
  await deps.createSecret({
    companyId: input.companyId,
    name: secretName,
    value,
    description: `LLM gateway key of agent "${agent.name}"; the board rotates it for this agent only`,
  });
  log(deps).info({ companyId: input.companyId, agentId: agent.id }, "agent gateway key created");
  return {
    view: {
      agentId: agent.id,
      secretName,
      present: true,
      valueHash: gatewayKeyValueHash(value),
      canManageKeys: true,
    },
    value,
  };
}

/**
 * Rotates one agent's gateway key. Both halves move: the gateway key and the
 * store entry. Nothing else references either, so the other agents' spend
 * attribution is untouched — that is the acceptance criterion this function
 * exists for.
 *
 * The gateway is updated first and must acknowledge the alias; a rotation that
 * the gateway did not apply is not written to the store, so the two can differ
 * only in the direction that keeps the agent authenticating with a value the
 * gateway knows.
 */
export async function rotateAgentGatewayKey(
  deps: AgentGatewayKeyDeps,
  input: AgentGatewayKeyInput,
): Promise<AgentGatewayKeyView> {
  const settings = requireKeyManagement(deps.env ?? process.env);
  const agent = await loadAgent(deps.db, input);
  const secretName = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });

  const secretId = await deps.findSecretId(input.companyId, secretName);
  if (!secretId) {
    throw notFound(
      `agent "${agent.name}" has no gateway key yet; create one first`,
      { code: "gateway_key_absent", secretName },
    );
  }

  const adminKey = await requireAdminKey(deps, input.companyId, settings);
  const value = generateGatewayKeyValue();
  const applied = await deps
    .gateway({ baseUrl: settings.baseUrl!, adminKey })
    .rotateKey({ alias: secretName, value });
  if (!applied) {
    throw unprocessable(
      `the gateway does not hold a key named "${secretName}"; the store was left unchanged`,
      { code: "gateway_key_unknown", secretName },
    );
  }
  await deps.rotateSecret(secretId, value);
  log(deps).info({ companyId: input.companyId, agentId: agent.id }, "agent gateway key rotated");
  return {
    agentId: agent.id,
    secretName,
    present: true,
    valueHash: gatewayKeyValueHash(value),
    canManageKeys: true,
  };
}

/**
 * The state of an agent's key. An agent reaches this for itself; a board member
 * for any agent of the company. The value is never part of the answer.
 */
export async function readAgentGatewayKey(
  deps: AgentGatewayKeyDeps,
  input: AgentGatewayKeyInput,
): Promise<AgentGatewayKeyView> {
  const settings = readGatewayKeySettings(deps.env ?? process.env);
  const agent = await loadAgent(deps.db, input);
  const secretName = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });
  const value = await deps.readSecretValue(input.companyId, secretName);
  return {
    agentId: agent.id,
    secretName,
    present: Boolean(value),
    valueHash: value ? gatewayKeyValueHash(value) : null,
    canManageKeys: settings.canManageKeys,
  };
}

/** Every agent of a company and whether each has a managed key. Names only. */
export async function listAgentGatewayKeys(
  deps: AgentGatewayKeyDeps,
  companyId: string,
): Promise<AgentGatewayKeyView[]> {
  const settings = readGatewayKeySettings(deps.env ?? process.env);
  const rows = await deps.db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const views: AgentGatewayKeyView[] = [];
  for (const row of rows) {
    const secretName = agentKeySecretName({ agentId: row.id, agentSlug: row.name });
    const value = await deps.readSecretValue(companyId, secretName);
    views.push({
      agentId: row.id,
      secretName,
      present: Boolean(value),
      valueHash: value ? gatewayKeyValueHash(value) : null,
      canManageKeys: settings.canManageKeys,
    });
  }
  return views;
}

/**
 * An agent may read its own key state and nothing else. A board member is not
 * narrowed here: the route checks the company, and a manager legitimately needs
 * the whole fleet's state.
 */
export function assertAgentMayReadOwnGatewayKey(input: {
  actorType: string;
  actorAgentId: string | null;
  requestedAgentId: string;
}): void {
  if (input.actorType !== "agent") return;
  if (input.actorAgentId && input.actorAgentId === input.requestedAgentId) return;
  throw forbidden("An agent may only read its own LLM gateway key");
}

/** Refuses a name this feature does not own: rotating a foreign secret is not ours to do. */
export function assertManagedKeySecretName(secretName: string): void {
  if (!secretName.startsWith(AGENT_KEY_SECRET_PREFIX)) {
    throw badRequest(`"${secretName}" is not a managed LLM gateway key secret`);
  }
}

/**
 * A key value the gateway accepts. The gateway hashes whatever value it is
 * given, so the format is ours to pick; 64 hex characters match the deployed
 * keys and are what M2-A hashes on the read side.
 */
export function generateGatewayKeyValue(): string {
  return createHash("sha256")
    .update(`${Date.now()}:${Math.random()}:${process.hrtime.bigint().toString()}`)
    .digest("hex");
}

/** sha256 hex of a key value: the form the gateway stores and M2-A matches. */
export function gatewayKeyValueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireKeyManagement(env: NodeJS.ProcessEnv): GatewayKeySettings & { baseUrl: string } {
  const settings = readGatewayKeySettings(env);
  if (!settings.canManageKeys || !settings.baseUrl) {
    throw unprocessable(
      "gateway key management is not enabled on this instance: no gateway address or admin key secret is configured",
      { code: "gateway_keys_disabled" },
    );
  }
  return { ...settings, baseUrl: settings.baseUrl };
}

async function requireAdminKey(
  deps: AgentGatewayKeyDeps,
  companyId: string,
  settings: GatewayKeySettings,
): Promise<string> {
  const name = settings.adminKeySecret;
  const value = name ? await deps.readSecretValue(companyId, name) : null;
  if (!value) {
    throw unprocessable("the gateway admin key is not available to the board", {
      code: "gateway_admin_key_missing",
    });
  }
  return value;
}

async function loadAgent(db: Db, input: AgentGatewayKeyInput): Promise<{ id: string; name: string }> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Agent not found in this company");
  return { id: row.id, name: row.name };
}

function log(deps: AgentGatewayKeyDeps): NonNullable<AgentGatewayKeyDeps["log"]> {
  return {
    info: deps.log?.info ?? (() => {}),
    warn: deps.log?.warn ?? (() => {}),
  };
}

/** The real wiring: the secrets service plus the gateway's key endpoints. */
export function defaultAgentGatewayKeyDeps(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): AgentGatewayKeyDeps {
  const secrets = secretService(db);
  return {
    db,
    env,
    readSecretValue: (companyId, secretName) =>
      secrets
        .getByName(companyId, secretName)
        .then((row) => (row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null)),
    findSecretId: (companyId, secretName) =>
      secrets.getByName(companyId, secretName).then((row) => row?.id ?? null),
    createSecret: async (input) => {
      const created = (await secrets.create(
        input.companyId,
        {
          name: input.name,
          key: input.name,
          value: input.value,
          description: input.description,
        } as never,
        { userId: null, agentId: null },
      )) as { id: string };
      return { id: created.id };
    },
    rotateSecret: async (secretId, value) => {
      await secrets.rotate(secretId, { value }, { userId: null, agentId: null });
    },
    gateway: ({ baseUrl, adminKey }) => createGatewayKeyAdminPort(baseUrl, adminKey),
  };
}

/**
 * The gateway's key endpoints, called with the ADMIN key.
 *
 * `/key/generate` and `/key/update` both take the value to install under `key`
 * (they hash it themselves); `key_alias` names the key. The value travels in
 * the request body, so the transport is the gateway's own TLS/socket and never
 * a query string.
 */
export function createGatewayKeyAdminPort(baseUrl: string, adminKey: string): GatewayKeyAdminPort {
  const url = (path: string) => `${baseUrl.replace(/\/$/, "")}${path}`;

  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw unprocessable(`LLM gateway ${path} answered ${response.status}`, {
        code: "gateway_key_request_failed",
        status: response.status,
      });
    }
    return { status: response.status, body: parsed };
  }

  return {
    async createKey({ alias, value }) {
      await post("/key/generate", { key_alias: alias, key: value });
    },
    async rotateKey({ alias, value }) {
      const response = await post("/key/update", { key_alias: alias, key: value });
      // A missing alias answers 404; anything else that reached here is applied.
      return response.status < 400;
    },
    async deleteKey({ alias }) {
      await post("/key/delete", { key_aliases: [alias] });
    },
  };
}