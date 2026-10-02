// myrmidon(CLOUD-CONNECTOR): where the connector keeps the owner's token.
//
// The token bundle lives in a company secret of the instance's own secret
// store — never in a bot, never in the connector's ordinary state document.
// The connector only ever holds the secret id (CloudAccount.tokenRef); the
// value is read and rotated through the vendor secret service, which owns
// encryption, versioning and the access audit.

import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/secrets.js";

export interface CloudTokenWriteInput {
  companyId: string;
  name: string;
  key: string;
  value: string;
  actor?: { userId?: string | null; agentId?: string | null };
}

export interface CloudTokenStore {
  /** Create the secret that will hold the token bundle. */
  write(input: CloudTokenWriteInput): Promise<{ secretId: string; version: number }>;
  /** Read the current bundle with its version, or null when the secret is gone or unreadable. */
  read(companyId: string, secretId: string): Promise<{ value: string; version: number } | null>;
  /** Replace the bundle after a refresh; the version guard catches a lost race. */
  rotate(input: { secretId: string; value: string; expectedLatestVersion: number }): Promise<number>;
}

/** Connector-owned consumer recorded in the secret access log. */
const CONNECTOR_CONSUMER_ID = "myrmidon-cloud-connector";

export function secretCloudTokenStore(db: Db): CloudTokenStore {
  const secrets = secretService(db);
  return {
    async write(input) {
      const secret = (await secrets.create(
        input.companyId,
        {
          name: input.name,
          key: input.key,
          provider: "local_encrypted",
          value: input.value,
          description: "OAuth token of the Myrmidon cloud connector; written by the panel, never by a bot.",
        },
        input.actor,
      )) as { id: string; latestVersion?: number };
      return { secretId: secret.id, version: secret.latestVersion ?? 1 };
    },

    async read(companyId, secretId) {
      try {
        const secret = (await secrets.getById(secretId)) as { latestVersion?: number; companyId?: string } | null;
        if (!secret || (secret.companyId !== undefined && secret.companyId !== companyId)) return null;
        const value = await secrets.resolveSecretValue(companyId, secretId, "latest", {
          accessContext: {
            consumerType: "system",
            consumerId: CONNECTOR_CONSUMER_ID,
            actorType: "system",
            issueId: null,
            heartbeatRunId: null,
            responsibleUserId: null,
          },
        });
        return { value, version: secret.latestVersion ?? 1 };
      } catch {
        // A rotated-out, archived or unreadable secret reads as "not connected".
        return null;
      }
    },

    async rotate(input) {
      const rotated = (await secrets.rotate(input.secretId, {
        value: input.value,
        expectedLatestVersion: input.expectedLatestVersion,
      })) as { latestVersion?: number } | null;
      return rotated?.latestVersion ?? input.expectedLatestVersion + 1;
    },
  };
}

/** In-memory store: used by tests and by read-only embeddings of the module. */
export function memoryCloudTokenStore(initial: Record<string, { value: string; version: number }> = {}): CloudTokenStore {
  const values = new Map(Object.entries(initial));
  let counter = 0;
  return {
    async write(input) {
      counter += 1;
      const secretId = `secret-${counter}`;
      values.set(secretId, { value: input.value, version: 1 });
      return { secretId, version: 1 };
    },
    async read(_companyId, secretId) {
      const entry = values.get(secretId);
      return entry ? { value: entry.value, version: entry.version } : null;
    },
    async rotate(input) {
      const current = values.get(input.secretId);
      const version = (current?.version ?? 0) + 1;
      values.set(input.secretId, { value: input.value, version });
      return version;
    },
  };
}