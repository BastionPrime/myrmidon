// server/src/myrmidon/bot-containers/card-env.ts
//
// myrmidon(W2a): a bot card's env bindings, resolved for the container profile.
//
// The same three rules a run of the card's agent lives by in the board's
// heartbeat, applied to the container path, which reaches the same secrets:
//   - The variables the board reserves for itself (PAPERCLIP_API_KEY, the runner
//     network and GitHub bridge variables) are never taken from a card, and
//     neither are the GitHub tokens a run drops when the board manages GitHub
//     credentials (GH_TOKEN, GITHUB_TOKEN and their siblings). A card that binds
//     one is dropped with a warning, exactly as a run drops it. A container
//     is never the host GitHub mode, in which a run would keep such a token, so
//     it takes the managed side of that choice: no static GitHub token in its .env.
//   - Secrets are resolved WITH a binding context (consumer: this agent, actor:
//     system), so the board checks that the secret is bound to this agent at
//     env.<NAME> and writes an access event. A resolve without a context checks
//     nothing: any secret id a card names, in the company, would open.
//   - The reconciler compiles every bot on every tick. A resolve with a context
//     writes an audit event per secret, so resolving each minute would drown the
//     audit log. The result is therefore kept in memory per agent and is resolved
//     again only when something it depends on changed: the card's env bindings,
//     or the latest version or status of a secret they refer to. (A secret's `updatedAt` is
//     no such signal: every resolve bumps it.)
//
// Pure over injected ports; profile-ports.ts binds them to the secrets service.

import { createHash } from "node:crypto";

import type { HermesProfileEnvEntry } from "./profile-compiler.js";

/**
 * The env names a card may not bind. A copy of the board's own list
 * (FORBIDDEN_ENV_BINDING_KEYS in services/heartbeat.ts, an unexported constant
 * of a file this fork keeps unedited); card-env.myrmidon.test.ts reads that
 * file and fails when the two lists differ.
 */
export const FORBIDDEN_CARD_ENV_KEYS: ReadonlySet<string> = new Set([
  "PAPERCLIP_RUNNER_NETWORK_ACCESS",
  "PAPERCLIP_RUNNER_NETWORK_ROOTS",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_GITHUB_AUTH_MODE",
  "PAPERCLIP_GITHUB_HOST_HOME",
  "PAPERCLIP_GIT_METADATA_ROOTS",
  "PAPERCLIP_GITHUB_BROKER_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_URL",
  "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
  "PAPERCLIP_GITHUB_LAUNCHER_DIR",
]);

/**
 * The GitHub tokens a run drops from a card when the board manages GitHub
 * credentials (MANAGED_GITHUB_TOKEN_KEYS in services/heartbeat.ts, likewise
 * unexported; card-env.myrmidon.test.ts reads that file and fails when the two
 * lists differ). A run keeps them only in host GitHub mode (a local or ssh
 * environment with no managed identity configured), which a container never is.
 */
export const MANAGED_GITHUB_CARD_ENV_KEYS: ReadonlySet<string> = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
]);

/** Who is asking, as the secrets service records and checks it. */
export interface CardEnvBindingContext {
  consumerType: "agent";
  consumerId: string;
  actorType: "system";
}

export interface CardEnvPorts {
  /** The secrets service's resolveEnvBindings: throws when a secret is not bound to the consumer. */
  resolveEnvBindings(
    companyId: string,
    bindings: Record<string, unknown>,
    context: CardEnvBindingContext,
  ): Promise<{ env: Record<string, string>; secretKeys: ReadonlySet<string> }>;
  /**
   * What a secret's resolved value depends on, as a string: its latest version and its status.
   * null when the secret does not exist. Must not resolve the secret (that writes an access event).
   */
  readSecretStamp(companyId: string, secretId: string): Promise<string | null>;
}

export interface CardEnvAgent {
  id: string;
  companyId: string;
  adapterConfig: Record<string, unknown>;
}

export interface ResolvedCardEnv {
  env: Record<string, HermesProfileEnvEntry>;
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** JSON with object keys sorted at every depth: equal data gives equal text whatever the key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createCardEnvResolver(ports: CardEnvPorts): (agent: CardEnvAgent) => Promise<ResolvedCardEnv> {
  const cache = new Map<string, { fingerprint: string; env: Record<string, HermesProfileEnvEntry> }>();

  return async function resolveCardEnv(agent: CardEnvAgent): Promise<ResolvedCardEnv> {
    const warnings: string[] = [];
    const bindings: Record<string, unknown> = {};
    for (const [name, binding] of Object.entries(asRecord(agent.adapterConfig.env))) {
      if (FORBIDDEN_CARD_ENV_KEYS.has(name)) {
        warnings.push(`env.${name}: the board reserves this variable, a card cannot set it, dropped`);
        continue;
      }
      if (MANAGED_GITHUB_CARD_ENV_KEYS.has(name)) {
        warnings.push(`env.${name}: GitHub credentials are managed by the board, a bot container carries none from a card, dropped`);
        continue;
      }
      if (asRecord(binding).type === "user_secret_ref") {
        // A per-user secret has no value without a user; a container has none.
        warnings.push(`env.${name}: a per-user secret cannot be used by a bot container, dropped`);
        continue;
      }
      bindings[name] = binding;
    }
    if (Object.keys(bindings).length === 0) {
      cache.delete(agent.id);
      return { env: {}, warnings };
    }

    const secretIds = new Set<string>();
    for (const binding of Object.values(bindings)) {
      const record = asRecord(binding);
      if (record.type === "secret_ref" && typeof record.secretId === "string") secretIds.add(record.secretId);
    }
    const stamps: string[] = [];
    for (const secretId of [...secretIds].sort()) {
      stamps.push(`${secretId}@${(await ports.readSecretStamp(agent.companyId, secretId)) ?? "missing"}`);
    }
    // Everything the resolved values depend on, and nothing that changes by itself.
    const fingerprint = createHash("sha256")
      .update(stableStringify({ companyId: agent.companyId, bindings, stamps }))
      .digest("hex");

    const cached = cache.get(agent.id);
    if (cached && cached.fingerprint === fingerprint) return { env: { ...cached.env }, warnings };

    const resolved = await ports.resolveEnvBindings(agent.companyId, bindings, {
      consumerType: "agent",
      consumerId: agent.id,
      actorType: "system",
    });
    const env: Record<string, HermesProfileEnvEntry> = {};
    for (const [name, value] of Object.entries(resolved.env)) {
      env[name] = { value, secret: resolved.secretKeys.has(name) };
    }
    // Set only after a successful resolve: a failure is retried on the next tick, never remembered.
    cache.set(agent.id, { fingerprint, env });
    return { env: { ...env }, warnings };
  };
}
