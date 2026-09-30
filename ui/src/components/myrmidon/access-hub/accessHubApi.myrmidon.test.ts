import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_GRANTEES,
  DEFAULT_AUDIT_LIMIT,
  EMPTY_ACCESS_FILTERS,
  accessHubApi,
  filterAccessRecords,
  formatAccessMoment,
  grantedAgents,
  hostNamesFor,
  latestAuditEntries,
  sshRevealForSelection,
  usedByBindings,
  type AccessAuditEntry,
  type AccessHost,
  type AccessRecord,
} from "./accessHubApi";

const apiMock = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(undefined),
  post: vi.fn().mockResolvedValue(undefined),
  put: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/api/client", () => ({ api: apiMock }));

const HOSTS: AccessHost[] = [
  { hostId: "host-a", name: "edge-1" },
  { hostId: "host-b", name: "edge-2" },
];

function record(overrides: Partial<AccessRecord> = {}): AccessRecord {
  return {
    secretId: "secret-a",
    name: "Deploy key",
    key: "DEPLOY_KEY",
    kind: "ssh_key",
    status: "active",
    latestVersion: 3,
    createdAt: "2026-09-20T10:00:00.000Z",
    lastRotatedAt: "2026-09-25T08:30:00.000Z",
    bindings: [
      { targetType: "agent", targetId: "agent-a", targetName: "Release bot", configPath: null },
      { targetType: "host", targetId: "host-a", targetName: "edge-1", configPath: "/srv/app/.env" },
    ],
    hostRefs: ["host-a", "host-b"],
    fingerprint: "SHA256:abc",
    ...overrides,
  };
}

describe("access hub API contract", () => {
  beforeEach(() => {
    apiMock.get.mockClear();
    apiMock.post.mockClear();
    apiMock.put.mockClear();
  });

  it("reads the access list, the journal and the host registry", async () => {
    await accessHubApi.listAccesses();
    await accessHubApi.audit();
    await accessHubApi.listHosts();

    expect(apiMock.get).toHaveBeenNthCalledWith(1, "/myrmidon/access-hub/accesses");
    expect(apiMock.get).toHaveBeenNthCalledWith(2, "/myrmidon/access-hub/audit");
    expect(apiMock.get).toHaveBeenNthCalledWith(3, "/myrmidon/access-hub/hosts");
  });

  it("writes values once, without ever asking for one back", async () => {
    await accessHubApi.saveSecretValue({ secretId: "secret-a", value: "typed-once" });
    await accessHubApi.generateSshKey({ name: "edge deploy key", hostRefs: ["host-a"] });

    expect(apiMock.post).toHaveBeenNthCalledWith(1, "/myrmidon/access-hub/secrets", {
      secretId: "secret-a",
      value: "typed-once",
    });
    expect(apiMock.post).toHaveBeenNthCalledWith(2, "/myrmidon/access-hub/secrets/generate-ssh", {
      name: "edge deploy key",
      hostRefs: ["host-a"],
    });
  });

  it("grants, revokes, rotates and moves host references", async () => {
    await accessHubApi.grant("secret-a", "agent-a");
    await accessHubApi.revoke("secret-a", "agent-a");
    await accessHubApi.rotate("secret-a", { external: true, restartContainers: true });
    await accessHubApi.setHostRefs("secret-a", ["host-b"]);

    expect(apiMock.post).toHaveBeenNthCalledWith(1, "/myrmidon/access-hub/accesses/secret-a/grant", {
      targetAgentId: "agent-a",
    });
    expect(apiMock.post).toHaveBeenNthCalledWith(2, "/myrmidon/access-hub/accesses/secret-a/revoke", {
      targetAgentId: "agent-a",
    });
    expect(apiMock.post).toHaveBeenNthCalledWith(3, "/myrmidon/access-hub/accesses/secret-a/rotate", {
      external: true,
      restartContainers: true,
    });
    expect(apiMock.put).toHaveBeenCalledWith("/myrmidon/access-hub/accesses/secret-a/hosts", {
      hostRefs: ["host-b"],
    });
  });
});

describe("access hub projections", () => {
  it("splits agent holders from usage bindings", () => {
    const value = record();

    expect(grantedAgents(value).map((binding) => binding.targetName)).toEqual(["Release bot"]);
    expect(usedByBindings(value).map((binding) => binding.targetName)).toEqual(["edge-1"]);
  });

  it("resolves host references to registry names", () => {
    expect(hostNamesFor(record(), HOSTS)).toEqual(["edge-1", "edge-2"]);
    expect(hostNamesFor(record({ hostRefs: ["host-unknown"] }), HOSTS)).toEqual(["host-unknown"]);
  });

  it("filters by kind, agent and free text", () => {
    const deployKey = record();
    const token = record({ secretId: "secret-b", name: "Registry token", key: "REGISTRY_TOKEN", kind: "token", bindings: [] });

    expect(filterAccessRecords([deployKey, token], EMPTY_ACCESS_FILTERS)).toHaveLength(2);
    expect(filterAccessRecords([deployKey, token], { ...EMPTY_ACCESS_FILTERS, kind: "token" })).toEqual([token]);
    expect(filterAccessRecords([deployKey, token], { ...EMPTY_ACCESS_FILTERS, agent: "agent-a" })).toEqual([
      deployKey,
    ]);
    expect(
      filterAccessRecords([deployKey, token], { ...EMPTY_ACCESS_FILTERS, agent: ALL_GRANTEES, search: "registry" }),
    ).toEqual([token]);
    expect(
      filterAccessRecords([deployKey, token], { ...EMPTY_ACCESS_FILTERS, search: "release bot" }),
    ).toEqual([deployKey]);
  });

  it("shows the newest journal lines first, capped by the limit", () => {
    const entries: AccessAuditEntry[] = [
      { at: "2026-09-20T00:00:00.000Z", actor: "a", action: "create", secretName: "x" },
      { at: "2026-09-25T00:00:00.000Z", actor: "b", action: "rotate", secretName: "x" },
      { at: "2026-09-22T00:00:00.000Z", actor: "c", action: "grant", secretName: "x" },
    ];

    expect(latestAuditEntries(entries, 2).map((entry) => entry.action)).toEqual(["rotate", "grant"]);
    expect(latestAuditEntries(entries, DEFAULT_AUDIT_LIMIT)).toHaveLength(3);
  });

  it("keeps a generated public key bound to its own card", () => {
    const material = { secretId: "secret-a", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:abc" };

    expect(sshRevealForSelection(material, "secret-a")).toEqual(material);
    expect(sshRevealForSelection(material, "secret-b")).toBeNull();
    expect(sshRevealForSelection(material, null)).toBeNull();
    expect(sshRevealForSelection(null, "secret-a")).toBeNull();
  });

  it("formats moments as fixed UTC, with a dash for never", () => {
    expect(formatAccessMoment("2026-09-25T08:30:00.000Z")).toBe("2026-09-25 08:30Z");
    expect(formatAccessMoment(null)).toBe("—");
    expect(formatAccessMoment(undefined)).toBe("—");
    expect(formatAccessMoment("not-a-date")).toBe("—");
  });
});