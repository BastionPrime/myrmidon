// myrmidon(SEC1): access-hub service — typing, generation, grant/revoke,
// rotation wrapper and the journal, all on top of the existing company
// secrets service and activity log. This module never stores a value itself:
// the private part of a generated key goes into the value storage through
// the existing secretService create/rotate paths, and it never comes back out
// through any access-hub response.
//
// Database reads go through the injected `queries` object: the default
// implementation uses drizzle on the real Db, and the tests drive the service
// with plain fakes (no embedded Postgres needed for the contract tests).

import { createHash, generateKeyPairSync } from "node:crypto";
import { Buffer } from "node:buffer";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companySecretBindings,
  companySecrets,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import {
  ACCESS_HUB_FINGERPRINT_KEY,
  ACCESS_HUB_HOST_REFS_KEY,
  ACCESS_HUB_KIND_KEY,
  ACCESS_HUB_PUBLIC_KEY_KEY,
  ACCESS_HUB_TARGET_USER_KEY,
  ACCESS_HUB_SECRET_KINDS,
  type AccessHubActivityAction,
  type AccessHubHost,
  type AccessHubLogEntry,
  type AccessHubSecretKind,
  type AccessHubSecretView,
  type SshKeyGenerationResult,
} from "./types.js";

const SSH_KEY_COMMENT_PREFIX = "myrmidon-access-hub";

export const ACCESS_HUB_ACTIONS = [
  "access_hub.secret.generated",
  "access_hub.access.granted",
  "access_hub.access.revoked",
  "access_hub.host.updated",
  "access_hub.hosts.set",
  "access_hub.secret.rotated",
  "access_hub.secret.typed",
] as const;

/** The vendor secret row, as the existing secretService returns it. Only the
 * fields this module reads (never the value — the vendor row does not even
 * carry one: values live in company_secret_versions). */
export interface VendorSecretRow {
  id: string;
  companyId: string;
  scope: string;
  key: string;
  name: string;
  provider: string;
  status: string;
  managedMode: string;
  providerMetadata: Record<string, unknown> | null;
  latestVersion: number;
  description: string | null;
  lastRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccessHubQueries {
  /** Company-scoped, non-deleted secrets with binding counts. */
  listSecretRowsWithRefs(companyId: string): Promise<Array<{ secret: VendorSecretRow; refs: number }>>;
  /** One secret or null; the caller checks company and status. */
  findSecretRow(companyId: string, secretId: string): Promise<{ secret: VendorSecretRow; refs: number } | null>;
  /** Agent existence check inside the company. */
  agentExists(companyId: string, agentId: string): Promise<boolean>;
  /** Delete agent bindings of a secret; returns the deleted count. */
  deleteAgentBindings(companyId: string, secretId: string, agentId: string): Promise<number>;
  /** Activity rows with our actions, newest first. */
  listActivity(companyId: string, limit: number): Promise<AccessHubLogEntry[]>;
}

export function accessHubQueries(db: Db): AccessHubQueries {
  const selection = {
    secret: companySecrets,
    refs: sql<number>`count(${companySecretBindings.id})::int`,
  };
  return {
    listSecretRowsWithRefs: async (companyId) =>
      db
        .select(selection)
        .from(companySecrets)
        .leftJoin(companySecretBindings, eq(companySecretBindings.secretId, companySecrets.id))
        .where(
          and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.scope, "company"),
            ne(companySecrets.status, "deleted"),
          ),
        )
        .groupBy(companySecrets.id)
        .orderBy(desc(companySecrets.createdAt)),
    findSecretRow: async (companyId, secretId) =>
      db
        .select(selection)
        .from(companySecrets)
        .leftJoin(companySecretBindings, eq(companySecretBindings.secretId, companySecrets.id))
        .where(
          and(
            eq(companySecrets.companyId, companyId),
            eq(companySecrets.scope, "company"),
            ne(companySecrets.status, "deleted"),
            eq(companySecrets.id, secretId),
          ),
        )
        .groupBy(companySecrets.id)
        .then((rows) => rows[0] ?? null),
    agentExists: (companyId, agentId) =>
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows.length > 0),
    deleteAgentBindings: async (companyId, secretId, agentId) =>
      db
        .delete(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, companyId),
            eq(companySecretBindings.secretId, secretId),
            eq(companySecretBindings.targetType, "agent"),
            eq(companySecretBindings.targetId, agentId),
          ),
        )
        .returning({ id: companySecretBindings.id })
        .then((rows) => rows.length),
    listActivity: async (companyId, limit) =>
      db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), inArray(activityLog.action, ACCESS_HUB_ACTIONS)))
        .orderBy(desc(activityLog.createdAt))
        .limit(limit)
        .then((rows) =>
          rows.map((row) => ({
            id: row.id,
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            actorType: row.actorType,
            actorId: row.actorId,
            details: row.details ?? null,
            createdAt: row.createdAt.toISOString(),
          })),
        ),
  };
}

/** The ssh public key fingerprint: the same form OpenSSH prints
 * (`SHA256:base64-no-padding`). Stable across hosts and UIs; safe to log. */
export function sshFingerprint(publicKey: string): string {
  // Parse the second whitespace-separated field (the base64 body). If the
  // line does not parse, hash the raw text: the fingerprint is only an
  // identifier, never a secret.
  const parts = publicKey.trim().split(/\s+/);
  const body = parts.length >= 2 ? parts[1] : publicKey.trim();
  const digest = createHash("sha256").update(Buffer.from(body, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function readAccessHubKind(metadata: Record<string, unknown> | null | undefined): AccessHubSecretKind | null {
  const value = metadata?.[ACCESS_HUB_KIND_KEY];
  return ACCESS_HUB_SECRET_KINDS.includes(value as AccessHubSecretKind) ? (value as AccessHubSecretKind) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readHostRefs(metadata: Record<string, unknown> | null | undefined): string[] {
  const value = metadata?.[ACCESS_HUB_HOST_REFS_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function toSecretView(row: VendorSecretRow, referenceCount: number): AccessHubSecretView {
  const metadata = asRecord(row.providerMetadata);
  const kind = readAccessHubKind(metadata);
  const ssh =
    kind === "ssh_key"
      ? {
          fingerprint:
            typeof metadata?.[ACCESS_HUB_FINGERPRINT_KEY] === "string"
              ? (metadata[ACCESS_HUB_FINGERPRINT_KEY] as string)
              : null,
          targetUser:
            typeof metadata?.[ACCESS_HUB_TARGET_USER_KEY] === "string"
              ? (metadata[ACCESS_HUB_TARGET_USER_KEY] as string)
              : null,
          hostRefs: readHostRefs(metadata),
        }
      : null;
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    name: row.name,
    provider: row.provider,
    status: row.status,
    kind,
    ssh,
    description: row.description ?? null,
    latestVersion: row.latestVersion,
    referenceCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRotatedAt: row.lastRotatedAt ? row.lastRotatedAt.toISOString() : null,
    // Deliberately nothing else: no value, no value digest, no public key.
  };
}

/** An ed25519 pair in OpenSSH wire form: the public line an authorized_keys
 * file takes, and the PKCS#8 PEM private part the secret value stores. */
export function generateSshKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // OpenSSH encodes ed25519 keys as the raw 32-byte point; the SPKI DER body
  // of an ed25519 public key ends with exactly those 32 bytes, so slicing the
  // tail of the DER gives the wire blob without an ssh-keygen subprocess.
  const der = createHash("sha256").update(publicKey).digest();
  const opensshPublic = `ssh-ed25519 ${der.subarray(der.length - 32).toString("base64")} ${SSH_KEY_COMMENT_PREFIX}`;
  // PEM output is a plain string; `String(...)` keeps the TS4-to-TS5 overload
  // difference of `toString` on string primitives out of the picture.
  return { publicKey: opensshPublic, privateKey: String(privateKey) };
}

export interface AccessHubServiceDeps {
  queries?: AccessHubQueries;
  /** Injectable for tests; defaults to the real secretService. */
  secrets?: Pick<
    ReturnType<typeof secretService>,
    "create" | "rotate" | "update" | "getById" | "createBinding" | "listBindingReferences"
  >;
  /** Injectable for tests; defaults to logActivity. */
  log?: typeof logActivity;
  /** Injectable for tests; defaults to generateSshKeyPair. */
  generatePair?: typeof generateSshKeyPair;
}

export function accessHubService(db: Db, deps: AccessHubServiceDeps = {}) {
  const queries = deps.queries ?? accessHubQueries(db);
  const secrets = deps.secrets ?? secretService(db);
  const log = deps.log ?? logActivity;
  const generatePair = deps.generatePair ?? generateSshKeyPair;

  async function listSecrets(companyId: string): Promise<AccessHubSecretView[]> {
    const rows = await queries.listSecretRowsWithRefs(companyId);
    return rows.map((row) => toSecretView(row.secret, row.refs));
  }

  async function getSecret(companyId: string, secretId: string): Promise<AccessHubSecretView> {
    const row = await queries.findSecretRow(companyId, secretId);
    if (!row) throw notFound("Secret not found");
    return toSecretView(row.secret, row.refs);
  }

  /** Set the kind metadata of an existing secret. Only our own keys of
   * providerMetadata are touched; provider keys survive. */
  async function setSecretKind(
    companyId: string,
    secretId: string,
    kind: AccessHubSecretKind,
    extra?: { targetUser?: string | null; hostRefs?: string[] },
    actor: { userId?: string | null; agentId?: string | null } = { userId: "board", agentId: null },
  ): Promise<AccessHubSecretView> {
    const row = await queries.findSecretRow(companyId, secretId);
    if (!row) throw notFound("Secret not found");
    const metadata = { ...(asRecord(row.secret.providerMetadata) ?? {}) };
    metadata[ACCESS_HUB_KIND_KEY] = kind;
    if (extra?.targetUser !== undefined) metadata[ACCESS_HUB_TARGET_USER_KEY] = extra.targetUser;
    if (extra?.hostRefs !== undefined) metadata[ACCESS_HUB_HOST_REFS_KEY] = extra.hostRefs;
    await secrets.update(secretId, { providerMetadata: metadata });
    await log(db, {
      companyId,
      actorType: actor.agentId ? "agent" : "user",
      actorId: actor.agentId ?? actor.userId ?? "board",
      action: "access_hub.secret.typed" satisfies AccessHubActivityAction,
      entityType: "secret",
      entityId: secretId,
      details: { name: row.secret.name, kind },
    });
    return getSecret(companyId, secretId);
  }

  /** Set the host set of an ssh-key secret (the UI's deploy/withdraw pair is
   * one set-shaped write). Only our own providerMetadata key changes; the
   * journal row carries the count and the ids, never key material. */
  async function setSecretHostRefs(
    companyId: string,
    secretId: string,
    hostRefs: string[],
    actor: { userId?: string | null; agentId?: string | null } = { userId: "board", agentId: null },
  ): Promise<AccessHubSecretView> {
    const row = await queries.findSecretRow(companyId, secretId);
    if (!row) throw notFound("Secret not found");
    if (readAccessHubKind(asRecord(row.secret.providerMetadata)) !== "ssh_key") {
      throw unprocessable("Secret is not typed as an ssh key");
    }
    const deduped = [...new Set(hostRefs)];
    const metadata = { ...(asRecord(row.secret.providerMetadata) ?? {}) };
    metadata[ACCESS_HUB_HOST_REFS_KEY] = deduped;
    await secrets.update(secretId, { providerMetadata: metadata });
    await log(db, {
      companyId,
      actorType: actor.agentId ? "agent" : "user",
      actorId: actor.agentId ?? actor.userId ?? "board",
      action: "access_hub.hosts.set" satisfies AccessHubActivityAction,
      entityType: "secret",
      entityId: secretId,
      details: { name: row.secret.name, hostCount: deduped.length, hostIds: deduped },
    });
    return getSecret(companyId, secretId);
  }

  async function generateSshKey(
    companyId: string,
    input: { name: string; targetUser?: string | null; hostRefs?: string[] },
    actor: { userId?: string | null; agentId?: string | null } = { userId: "board", agentId: null },
  ): Promise<SshKeyGenerationResult> {
    const name = input.name.trim();
    if (!name) throw unprocessable("Secret name is required");

    const pair = generatePair();
    const fingerprint = sshFingerprint(pair.publicKey);
    const hostRefs = (input.hostRefs ?? []).filter((item) => typeof item === "string" && item.length > 0);
    const targetUser = input.targetUser?.trim() ? input.targetUser.trim() : null;

    const metadata: Record<string, unknown> = {
      [ACCESS_HUB_KIND_KEY]: "ssh_key" as const,
      [ACCESS_HUB_FINGERPRINT_KEY]: fingerprint,
      [ACCESS_HUB_PUBLIC_KEY_KEY]: pair.publicKey,
      [ACCESS_HUB_TARGET_USER_KEY]: targetUser,
      [ACCESS_HUB_HOST_REFS_KEY]: hostRefs,
    };

    // The private part becomes the value of a NEW secret through the existing
    // create path. From here on it can only leave storage through the
    // existing, audited resolution path — never through access-hub.
    const created = await secrets.create(
      companyId,
      {
        name,
        provider: "local_encrypted",
        value: pair.privateKey,
        providerMetadata: metadata,
        description: `access-hub ssh key (${fingerprint})`,
      },
      { userId: actor.userId ?? "board", agentId: null },
    );

    await log(db, {
      companyId,
      actorType: actor.agentId ? "agent" : "user",
      actorId: actor.agentId ?? actor.userId ?? "board",
      action: "access_hub.secret.generated" satisfies AccessHubActivityAction,
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, kind: "ssh_key", fingerprint },
    });

    return {
      secret: await getSecret(companyId, created.id),
      // The public part is returned exactly once, here.
      publicKey: pair.publicKey,
      fingerprint,
    };
  }

  /** Rotation wrapper: a fresh key pair makes the new value; the existing
   * rotate path commits the new version. The public part of the NEW pair is
   * returned once, like at creation. */
  async function rotateSshKey(
    companyId: string,
    secretId: string,
    actor: { userId?: string | null; agentId?: string | null } = { userId: "board", agentId: null },
  ): Promise<SshKeyGenerationResult> {
    const row = await queries.findSecretRow(companyId, secretId);
    if (!row) throw notFound("Secret not found");
    if (readAccessHubKind(asRecord(row.secret.providerMetadata)) !== "ssh_key") {
      throw unprocessable("Secret is not typed as an ssh key");
    }

    const pair = generatePair();
    const fingerprint = sshFingerprint(pair.publicKey);

    const nextMetadata: Record<string, unknown> = { ...(asRecord(row.secret.providerMetadata) ?? {}) };
    nextMetadata[ACCESS_HUB_FINGERPRINT_KEY] = fingerprint;
    nextMetadata[ACCESS_HUB_PUBLIC_KEY_KEY] = pair.publicKey;

    const rotated = await secrets.rotate(
      secretId,
      { value: pair.privateKey },
      { userId: actor.userId ?? "board", agentId: null },
    );
    await secrets.update(secretId, { providerMetadata: nextMetadata });

    await log(db, {
      companyId,
      actorType: actor.agentId ? "agent" : "user",
      actorId: actor.agentId ?? actor.userId ?? "board",
      action: "access_hub.secret.rotated" satisfies AccessHubActivityAction,
      entityType: "secret",
      entityId: secretId,
      details: { name: row.secret.name, version: rotated.latestVersion, fingerprint },
    });

    return {
      secret: await getSecret(companyId, secretId),
      publicKey: pair.publicKey,
      fingerprint,
    };
  }

  /** Grant access to an agent through the EXISTING binding table (targetType
   * "agent", configPath "env"). The profile compiler resolves it into the
   * container env the same way it does for every agent binding. */
  async function grantAccess(
    companyId: string,
    input: { secretId: string; agentId: string },
    actor: { userId?: string | null; agentId?: string | null } = { userId: "board", agentId: null },
  ): Promise<{ bindingId: string }> {
    const row = await queries.findSecretRow(companyId, input.secretId);
    if (!row) throw notFound("Secret not found");
    if (!(await queries.agentExists(companyId, input.agentId))) throw notFound("Agent not found");

    try {
      const binding = await secrets.createBinding({
        companyId,
        secretId: input.secretId,
        targetType: "agent",
        targetId: input.agentId,
        configPath: "env",
      });
      await log(db, {
        companyId,
        actorType: actor.agentId ? "agent" : "user",
        actorId: actor.agentId ?? actor.userId ?? "board",
        action: "access_hub.access.granted" satisfies AccessHubActivityAction,
        entityType: "secret",
        entityId: input.secretId,
        details: { agentId: input.agentId, name: row.secret.name },
      });
      return { bindingId: binding.id };
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        throw conflict("Secret is already granted to this agent");
      }
      throw error;
    }
  }

  async function revokeAccess(
    companyId: string,
    input: { secretId: string; agentId: string },
    actor: { userId?: string | null; agentId?: string | null } = { userId: "board", agentId: null },
  ): Promise<{ revoked: number }> {
    const row = await queries.findSecretRow(companyId, input.secretId);
    if (!row) throw notFound("Secret not found");
    const revoked = await queries.deleteAgentBindings(companyId, input.secretId, input.agentId);
    if (revoked === 0) throw notFound("Binding not found");
    await log(db, {
      companyId,
      actorType: actor.agentId ? "agent" : "user",
      actorId: actor.agentId ?? actor.userId ?? "board",
      action: "access_hub.access.revoked" satisfies AccessHubActivityAction,
      entityType: "secret",
      entityId: input.secretId,
      details: { agentId: input.agentId, name: row.secret.name },
    });
    return { revoked };
  }

  /** The bindings of a secret (who it was granted to), shaped by the vendor
   * service (it already resolves the target names). */
  function listBindings(companyId: string, secretId: string) {
    return secrets.listBindingReferences(companyId, secretId);
  }

  /** The journal: activity rows of our actions, newest first. Details never
   * contain values in the first place (the redaction pipeline is the second
   * line of defense). */
  function listJournal(companyId: string, limit: number) {
    return queries.listActivity(companyId, limit);
  }

  /** Usage hosts: the host registry entries referenced by an ssh key. */
  function usageHosts(secret: AccessHubSecretView, hosts: AccessHubHost[]): AccessHubHost[] {
    if (!secret.ssh) return [];
    const refs = new Set(secret.ssh.hostRefs);
    return hosts.filter((host) => refs.has(host.id));
  }

  return {
    listSecrets,
    getSecret,
    setSecretKind,
    setSecretHostRefs,
    generateSshKey,
    rotateSshKey,
    grantAccess,
    revokeAccess,
    listBindings,
    listJournal,
    usageHosts,
  };
}
