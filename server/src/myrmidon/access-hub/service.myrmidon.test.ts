// myrmidon(SEC1): access-hub service + host registry tests (plain fakes, no
// database — the contract of part A; the routes test file covers the HTTP
// layer, this one the domain rules).
//
// Neutral data only: agent-a@example.com style ids, example.com hosts.

import { describe, expect, it } from "vitest";
import {
  parseAccessHubHosts,
  validateAccessHubHost,
  isValidHostAddress,
  preserveAccessHubHostsGeneralKey,
  ACCESS_HUB_HOSTS_GENERAL_KEY,
} from "./host-registry.js";
import { createFakeDeployPort } from "./ssh-deploy.js";
import {
  generateSshKeyPair,
  readAccessHubKind,
  sshFingerprint,
  accessHubService,
  type AccessHubQueries,
  type VendorSecretRow,
} from "./service.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "11111111-1111-4111-8111-111111111111";

function secretRow(overrides: Partial<VendorSecretRow> = {}): VendorSecretRow {
  const now = new Date("2026-10-01T00:00:00Z");
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: COMPANY,
    scope: "company",
    key: "agent-a-key",
    name: "agent-a-key",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastRotatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeQueries(rows: VendorSecretRow[] = [secretRow()], activity: Array<Record<string, unknown>> = []) {
  const bindings = new Map<string, string[]>(); // secretId -> agent ids
  const queries: AccessHubQueries = {
    listSecretRowsWithRefs: async (companyId) =>
      rows
        .filter((row) => row.companyId === companyId && row.status !== "deleted")
        .map((secret) => ({ secret, refs: bindings.get(secret.id)?.length ?? 0 })),
    findSecretRow: async (companyId, secretId) => {
      const found = rows.find(
        (row) => row.companyId === companyId && row.id === secretId && row.status !== "deleted",
      );
      return found ? { secret: found, refs: bindings.get(found.id)?.length ?? 0 } : null;
    },
    agentExists: async (_companyId, agentId) => agentId === AGENT,
    deleteAgentBindings: async (_companyId, secretId, agentId) => {
      const current = bindings.get(secretId) ?? [];
      const next = current.filter((id) => id !== agentId);
      const removed = current.length - next.length;
      bindings.set(secretId, next);
      return removed;
    },
    listActivity: async (companyId, limit) =>
      activity
        .filter((entry) => entry.companyId === companyId)
        .slice(0, limit)
        .map((entry) => ({ ...entry, createdAt: String(entry.createdAt) })) as never,
  };
  return { queries, bindings };
}

function fakeSecrets(rows: VendorSecretRow[], grants?: Map<string, string[]>) {
  const created: Array<Record<string, unknown>> = [];
  const rotated: Array<{ secretId: string; value: string }> = [];
  const updated: Array<{ secretId: string; providerMetadata: Record<string, unknown> }> = [];
  const bindingRows: Array<{ id: string; secretId: string; targetId: string }> = [];
  let counter = 0;
  return {
    created,
    rotated,
    updated,
    bindingRows,
    secrets: {
      create: async (companyId: string, input: Record<string, unknown>) => {
        counter += 1;
        const row = secretRow({
          id: `90000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
          companyId,
          key: String(input.name ?? "key"),
          name: String(input.name ?? "name"),
          providerMetadata: (input.providerMetadata as Record<string, unknown>) ?? null,
          latestVersion: 1,
        });
        created.push({ companyId, ...input });
        rows.push(row);
        return row;
      },
      rotate: async (secretId: string, input: { value?: string | null }) => {
        const row = rows.find((item) => item.id === secretId);
        if (!row) throw new Error("Secret not found");
        row.latestVersion += 1;
        rotated.push({ secretId, value: String(input.value ?? "") });
        return { ...row };
      },
      update: async (secretId: string, patch: { providerMetadata?: Record<string, unknown> | null }) => {
        const row = rows.find((item) => item.id === secretId);
        if (!row) throw new Error("Secret not found");
        if (patch.providerMetadata !== undefined) row.providerMetadata = patch.providerMetadata;
        updated.push({ secretId, providerMetadata: patch.providerMetadata ?? {} });
        return { ...row };
      },
      getById: async (secretId: string) => rows.find((item) => item.id === secretId) ?? null,
      createBinding: async (input: { secretId: string; targetId: string; targetType: string; configPath: string }) => {
        if (bindingRows.some((b) => b.secretId === input.secretId && b.targetId === input.targetId)) {
          throw new Error(`Secret binding already exists at ${input.configPath}`);
        }
        const binding = { id: `80000000-0000-4000-8000-${String(bindingRows.length + 1).padStart(12, "0")}`, secretId: input.secretId, targetId: input.targetId };
        bindingRows.push(binding);
        // Keep the queries-side grant map in step, so the two fakes share one
        // picture of who holds the secret.
        grants?.set(
          input.secretId,
          [...(grants.get(input.secretId) ?? []), input.targetId],
        );
        return binding;
      },
      listBindingReferences: async () => [],
    },
  };
}

function fakeLog() {
  const entries: Array<Record<string, unknown>> = [];
  const log = async (_db: unknown, input: Record<string, unknown>) => {
    entries.push(input);
    return { id: "activity-id" };
  };
  return { entries, log };
}

const PEM_HEADER = `-----BEGIN ` + "PRIVATE KEY" + `-----`;

describe("myrmidon(SEC1) access-hub: ssh key material", () => {
  it("generates an OpenSSH-form ed25519 public line and a PEM private part", () => {
    const pair = generateSshKeyPair();
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{43}= myrmidon-access-hub$/);
    expect(pair.privateKey).toContain(PEM_HEADER);
  });

  it("fingerprints the public line in OpenSSH SHA256 form, stable across calls", () => {
    const pair = generateSshKeyPair();
    expect(sshFingerprint(pair.publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(sshFingerprint(pair.publicKey)).toBe(sshFingerprint(pair.publicKey));
    expect(sshFingerprint(pair.publicKey)).not.toBe(sshFingerprint(generateSshKeyPair().publicKey));
  });
});

describe("myrmidon(SEC1) access-hub service: typing and the value contract", () => {
  it("generation creates a secret through the existing create path with the private part as the value", async () => {
    const rows: VendorSecretRow[] = [];
    const fake = fakeSecrets(rows);
    const secrets = fake.secrets;
    const { queries } = fakeQueries(rows);
    const { entries, log } = fakeLog();
    const svc = accessHubService({} as never, {
      queries,
      secrets: secrets as never,
      log: log as never,
    });

    const result = await svc.generateSshKey(COMPANY, { name: "agent-a-ssh", targetUser: "agent-a" });

    // The private part went into the create call (value storage) exactly once.
    expect(fake.created).toHaveLength(1);
    expect(String(fake.created[0].value)).toContain("PRIVATE KEY");
    expect(String(fake.created[0].provider)).toBe("local_encrypted");

    // The response carries the public part exactly once, plus the view.
    expect(result.publicKey).toMatch(/^ssh-ed25519 /);
    expect(result.fingerprint).toBe(sshFingerprint(result.publicKey));
    expect(result.secret.kind).toBe("ssh_key");
    expect(result.secret.ssh?.fingerprint).toBe(result.fingerprint);
    expect(result.secret.ssh?.targetUser).toBe("agent-a");

    // The list view NEVER contains the public part or any value-like field.
    const all = await svc.listSecrets(COMPANY);
    expect(all).toHaveLength(1);
    const view = JSON.stringify(all[0]);
    expect(view).not.toContain("sshPublicKey");
    expect(view).not.toContain("-----BEGIN");
    expect(all[0].ssh?.fingerprint).toBe(result.fingerprint);

    // The journal row carries only name, kind and fingerprint — no material.
    expect(entries).toHaveLength(1);
    const details = JSON.stringify(entries[0].details);
    expect(details).toContain("agent-a-ssh");
    expect(details).toContain("ssh_key");
    expect(details).not.toContain("-----BEGIN");
    expect(details).not.toContain(result.publicKey);
  });

  it("a generated private part never appears in any list, get, journal or binding payload", async () => {
    const rows: VendorSecretRow[] = [];
    const fake = fakeSecrets(rows);
    const secrets = fake.secrets;
    const { queries } = fakeQueries(rows);
    const { entries, log } = fakeLog();
    const svc = accessHubService({} as never, {
      queries,
      secrets: secrets as never,
      log: log as never,
    });

    const result = await svc.generateSshKey(COMPANY, { name: "agent-a-ssh" });
    const privatePart = String(fake.created[0].value);
    expect(privatePart).toContain(PEM_HEADER);

    const list = JSON.stringify(await svc.listSecrets(COMPANY));
    const single = JSON.stringify(await svc.getSecret(COMPANY, result.secret.id));
    const journal = JSON.stringify(entries);
    expect(list).not.toContain(privatePart);
    expect(single).not.toContain(privatePart);
    expect(journal).not.toContain(privatePart);
    expect(list).not.toContain(result.publicKey);
    expect(single).not.toContain(result.publicKey);
  });

  it("setSecretHostRefs writes the ssh host set, dedupes, and journals ids only", async () => {
    const row = secretRow({ providerMetadata: { kind: "ssh_key", foreignKey: "kept" } });
    const rows = [row];
    const fake = fakeSecrets(rows);
    const { queries } = fakeQueries(rows);
    const { entries, log } = fakeLog();
    const svc = accessHubService({} as never, { queries, secrets: fake.secrets as never, log: log as never });

    const view = await svc.setSecretHostRefs(COMPANY, row.id, ["h1", "h1", "h2"]);
    expect(view.ssh?.hostRefs).toEqual(["h1", "h2"]);
    const written = rows[0].providerMetadata as Record<string, unknown>;
    expect(Array.isArray(written.hostRefs)).toBe(true);
    expect(written.hostRefs).toEqual(["h1", "h2"]);
    // Foreign metadata keys survive the write.
    expect(written.foreignKey).toBe("kept");

    // Journal: ids and the count, never key material.
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("access_hub.hosts.set");
    const details = JSON.stringify(entries[0].details);
    expect(details).toContain("h1");
    expect(details).not.toContain("-----BEGIN");
  });

  it("setSecretHostRefs refuses a secret that is not typed as an ssh key", async () => {
    const rows = [secretRow()];
    const fake = fakeSecrets(rows);
    const { queries } = fakeQueries(rows);
    const svc = accessHubService({} as never, { queries, secrets: fake.secrets as never, log: (async () => ({})) as never });
    await expect(svc.setSecretHostRefs(COMPANY, rows[0].id, ["h1"])).rejects.toThrow(
      "Secret is not typed as an ssh key",
    );
  });

  it("setSecretKind writes the kind and keeps foreign provider metadata keys", async () => {
    const row = secretRow({
      providerMetadata: { foreignKey: "kept", other: 7 },
    });
    const rows = [row];
    const { secrets } = fakeSecrets(rows);
    const { queries } = fakeQueries(rows);
    const { entries, log } = fakeLog();
    const svc = accessHubService({} as never, { queries, secrets: secrets as never, log: log as never });

    const view = await svc.setSecretKind(COMPANY, row.id, "password");
    expect(view.kind).toBe("password");
    const written = rows[0].providerMetadata as Record<string, unknown>;
    expect(written.kind).toBe("password");
    expect(written.foreignKey).toBe("kept");
    expect(written.other).toBe(7);
    expect(entries.map((entry) => entry.action)).toEqual(["access_hub.secret.typed"]);
  });

  it("rotateSshKey refuses a secret that is not typed as an ssh key", async () => {
    const rows = [secretRow()];
    const { secrets } = fakeSecrets(rows);
    const { queries } = fakeQueries(rows);
    const svc = accessHubService({} as never, { queries, secrets: secrets as never, log: (async () => ({})) as never });
    await expect(svc.rotateSshKey(COMPANY, rows[0].id)).rejects.toThrow("Secret is not typed as an ssh key");
  });

  it("grant and revoke go through the existing binding table", async () => {
    const rows = [secretRow()];
    const { queries, bindings } = fakeQueries(rows);
    const { secrets } = fakeSecrets(rows, bindings);
    const { entries, log } = fakeLog();
    const svc = accessHubService({} as never, { queries, secrets: secrets as never, log: log as never });

    const granted = await svc.grantAccess(COMPANY, { secretId: rows[0].id, agentId: AGENT });
    expect(granted.bindingId).toBeTruthy();
    expect(bindings.get(rows[0].id)).toEqual([AGENT]);
    await expect(
      svc.grantAccess(COMPANY, { secretId: rows[0].id, agentId: AGENT }),
    ).rejects.toThrow(/already granted/i);

    const revoked = await svc.revokeAccess(COMPANY, { secretId: rows[0].id, agentId: AGENT });
    expect(revoked.revoked).toBe(1);
    expect(bindings.get(rows[0].id)).toEqual([]);
    await expect(
      svc.revokeAccess(COMPANY, { secretId: rows[0].id, agentId: AGENT }),
    ).rejects.toThrow(/not found/i);

    // Journal actions for the whole cycle; agent ids only, never values.
    expect(entries.map((entry) => entry.action)).toEqual([
      "access_hub.access.granted",
      "access_hub.access.revoked",
    ]);
    for (const entry of entries) {
      expect(JSON.stringify(entry.details)).not.toContain("-----BEGIN");
    }
  });

  it("usageHosts returns the registry entries the ssh key references", () => {
    const svc = accessHubService({} as never, {
      queries: fakeQueries([]).queries,
      secrets: fakeSecrets([]).secrets as never,
      log: (async () => ({})) as never,
    });
    const secret = {
      ssh: { fingerprint: "SHA256:x", targetUser: "agent-a", hostRefs: ["h1", "h3"] },
    } as never;
    const hosts = [
      { id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true },
      { id: "h2", name: "build-2", address: "192.0.2.10", targetUser: "agent-a", enabled: true },
      { id: "h3", name: "build-3", address: "2001:db8::1", targetUser: "agent-b", enabled: false },
    ];
    expect(svc.usageHosts(secret, hosts)).toEqual([hosts[0], hosts[2]]);
    expect(svc.usageHosts({ ssh: null } as never, hosts)).toEqual([]);
  });
});

describe("myrmidon(SEC1) host registry", () => {
  it("parses stored JSON, skipping malformed entries instead of failing", () => {
    const parsed = parseAccessHubHosts([
      { id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true },
      "garbage",
      { id: "h2", name: "no-address" },
      null,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true });
    expect(parseAccessHubHosts(undefined)).toEqual([]);
    expect(parseAccessHubHosts("nope")).toEqual([]);
  });

  it("validates neutral addresses and rejects the rest", () => {
    expect(isValidHostAddress("example.com")).toBe(true);
    expect(isValidHostAddress("build-1.internal.example.com")).toBe(true);
    expect(isValidHostAddress("192.0.2.10")).toBe(true);
    expect(isValidHostAddress("2001:db8::1")).toBe(true);
    expect(isValidHostAddress("[2001:db8::1]")).toBe(true);
    expect(isValidHostAddress("not a host")).toBe(false);
    expect(isValidHostAddress("")).toBe(false);
    expect(isValidHostAddress("a".repeat(300))).toBe(false);
  });

  it("validateAccessHubHost names the first invalid field", () => {
    expect(validateAccessHubHost({ name: "build-1", address: "example.com", targetUser: "agent-a" })).toBeNull();
    expect(validateAccessHubHost({ name: "", address: "example.com", targetUser: "agent-a" })).toBe("name");
    expect(validateAccessHubHost({ name: "build-1", address: "not a host", targetUser: "agent-a" })).toBe("address");
    expect(validateAccessHubHost({ name: "build-1", address: "example.com", targetUser: "" })).toBe("targetUser");
  });

  it("preserves only the access-hub key of a vendor general write", () => {
    const general = {
      censorUsernameInLogs: false,
      [ACCESS_HUB_HOSTS_GENERAL_KEY]: [{ id: "h1", name: "build-1", address: "example.com", targetUser: "agent-a", enabled: true }],
      someoneElsesKey: 1,
    };
    const carried = preserveAccessHubHostsGeneralKey(general);
    expect(Object.keys(carried)).toEqual([ACCESS_HUB_HOSTS_GENERAL_KEY]);
    expect(preserveAccessHubHostsGeneralKey({ other: 1 })).toEqual({});
    expect(preserveAccessHubHostsGeneralKey(null)).toEqual({});
  });
});

describe("myrmidon(SEC1) fake deploy port", () => {
  it("records calls and is idempotent per host and fingerprint", async () => {
    const port = createFakeDeployPort();
    const input = {
      hostId: "h1",
      address: "example.com",
      targetUser: "agent-a",
      fingerprint: "SHA256:abc",
      publicKey: "ssh-ed25519 AAAA myrmidon-access-hub",
      secretId: "sec-1",
    };
    const first = await port.deploy(input);
    expect(first.outcome).toBe("deployed");
    const second = await port.deploy(input);
    expect(second.outcome).toBe("already_present");
    const dry = await port.dryRun(input);
    expect(dry.outcome).toBe("already_present");
    const revoked = await port.revoke(input);
    expect(revoked.outcome).toBe("deployed");
    const revokedAgain = await port.revoke(input);
    expect(revokedAgain.outcome).toBe("not_deployed");
    expect(port.calls.map((call) => call.op)).toEqual([
      "deploy",
      "deploy",
      "dryRun",
      "revoke",
      "revoke",
    ]);
  });
});

describe("myrmidon(SEC1) readAccessHubKind", () => {
  it("accepts the four kinds and rejects anything else", () => {
    expect(readAccessHubKind({ kind: "ssh_key" })).toBe("ssh_key");
    expect(readAccessHubKind({ kind: "password" })).toBe("password");
    expect(readAccessHubKind({ kind: "token" })).toBe("token");
    expect(readAccessHubKind({ kind: "oauth" })).toBe("oauth");
    expect(readAccessHubKind({ kind: "nope" })).toBeNull();
    expect(readAccessHubKind({})).toBeNull();
    expect(readAccessHubKind(null)).toBeNull();
  });
});
