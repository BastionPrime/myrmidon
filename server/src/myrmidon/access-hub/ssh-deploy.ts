// myrmidon(SEC1): ssh-deploy — the DeployPort interface and a fake
// implementation. The real ssh client (authorized_keys layout on fleet hosts)
// is part C of the Secrets UI plan and lands in its own branch on top of this
// interface. Part A ships only the contract and the fake, so the routes,
// the journal and the tests can be exercised end to end without any network.

/**
 * Deploy a public key to a host: add the key line to the target user's
 * authorized_keys, idempotently. Returns the fingerprint that is now laid
 * out on the host.
 *
 * `dryRun` performs the same checks (host reachable, key parseable) but
 * writes nothing and reports what a real run would do.
 */
export type DeployPublicKey = (input: DeployInput) => Promise<DeployResult>;

/** Remove a public key (by fingerprint) from the host's authorized_keys. */
export type RevokePublicKey = (input: DeployInput) => Promise<DeployResult>;

export interface DeployInput {
  hostId: string;
  address: string;
  targetUser: string;
  fingerprint: string;
  publicKey: string;
}

export interface DeployResult {
  /** What happened: "deployed" | "already_present" | "dry_run" | "not_deployed". */
  outcome: "deployed" | "already_present" | "dry_run" | "not_deployed";
  /** Human-readable note for the journal; NEVER a secret value. */
  note: string | null;
}

export interface DeployPort {
  deploy: DeployPublicKey;
  revoke: RevokePublicKey;
  /** Check without writing: does the port believe it could act on this host? */
  dryRun: (input: DeployInput) => Promise<DeployResult>;
}

/**
 * The fake implementation. It records every call for tests and answers
 * deterministically: deploy is idempotent ("already_present" for a repeated
 * fingerprint on the same host), revoke of an unknown key is "not_deployed".
 * No network, no filesystem, no process: part C replaces this object with a
 * real ssh client behind the same interface.
 */
export function createFakeDeployPort(): DeployPort & {
  calls: Array<{ op: "deploy" | "revoke" | "dryRun"; input: DeployInput }>;
} {
  const calls: Array<{ op: "deploy" | "revoke" | "dryRun"; input: DeployInput }> = [];
  const deployed = new Set<string>(); // `${hostId}:${fingerprint}`

  return {
    calls,
    deploy: async (input) => {
      calls.push({ op: "deploy", input });
      const marker = `${input.hostId}:${input.fingerprint}`;
      if (deployed.has(marker)) {
        return { outcome: "already_present", note: `key already present on host ${input.hostId}` };
      }
      deployed.add(marker);
      return { outcome: "deployed", note: `key added to host ${input.hostId}` };
    },
    revoke: async (input) => {
      calls.push({ op: "revoke", input });
      const marker = `${input.hostId}:${input.fingerprint}`;
      if (!deployed.has(marker)) {
        return { outcome: "not_deployed", note: `key was not present on host ${input.hostId}` };
      }
      deployed.delete(marker);
      return { outcome: "deployed", note: `key removed from host ${input.hostId}` };
    },
    dryRun: async (input) => {
      calls.push({ op: "dryRun", input });
      const marker = `${input.hostId}:${input.fingerprint}`;
      return {
        outcome: deployed.has(marker) ? "already_present" : "dry_run",
        note: `dry run on host ${input.hostId}`,
      };
    },
  };
}
