// myrmidon(CLOUD-CONNECTOR): access-model tests.
//
// The grant rules are the heart of the feature: an agent, a caste or everyone
// gets a root with a mode, the most specific grant wins, and a folder another
// account shared with us can never become read-write.

import { describe, expect, it } from "vitest";
import type { CloudGrant, CloudRoot } from "@paperclipai/shared/myrmidon-cloud-connector";
import {
  allowsWrite,
  appliesTo,
  assertModeAllowedForRoot,
  outsideGrantMessage,
  personalRootFolder,
  personalRootName,
  readOnlyMessage,
  resolveAccess,
  resolveNamedRoot,
} from "./grants.js";

const OWN_ROOT: CloudRoot = {
  id: "root-own-work",
  providerId: "onedrive",
  companyId: "company-a",
  name: "work",
  kind: "own",
  description: "",
  driveId: null,
  itemId: null,
  folder: "Agents/agent-a",
  personalForAgentId: "agent-a",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SHARED_ROOT: CloudRoot = {
  id: "root-shared-media",
  providerId: "onedrive",
  companyId: "company-a",
  name: "shared",
  kind: "shared",
  description: "",
  driveId: "drive-x",
  itemId: "item-y",
  folder: null,
  personalForAgentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function grant(overrides: Partial<CloudGrant>): CloudGrant {
  return {
    id: "grant-1",
    rootId: OWN_ROOT.id,
    targetKind: "agent",
    agentId: "agent-a",
    caste: null,
    mode: "ro",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "board",
    ...overrides,
  };
}

describe("assertModeAllowedForRoot", () => {
  it("refuses read-write on a folder shared with us", () => {
    expect(() => assertModeAllowedForRoot(SHARED_ROOT, "rw")).toThrow(/read-only/);
    expect(() => assertModeAllowedForRoot(SHARED_ROOT, "ro")).not.toThrow();
    expect(() => assertModeAllowedForRoot(OWN_ROOT, "rw")).not.toThrow();
  });
});

describe("appliesTo", () => {
  it("matches an agent grant by id, a caste grant by caste and 'all' always", () => {
    expect(appliesTo(grant({}), { agentId: "agent-a", caste: null })).toBe(true);
    expect(appliesTo(grant({}), { agentId: "agent-b", caste: null })).toBe(false);
    expect(appliesTo(grant({ targetKind: "caste", agentId: null, caste: "builders" }), { agentId: "agent-b", caste: "builders" })).toBe(true);
    expect(appliesTo(grant({ targetKind: "caste", agentId: null, caste: "builders" }), { agentId: "agent-b", caste: null })).toBe(false);
    expect(appliesTo(grant({ targetKind: "all", agentId: null }), { agentId: "agent-z", caste: null })).toBe(true);
  });
});

describe("resolveAccess", () => {
  it("keeps only the roots the agent was granted", () => {
    const resolved = resolveAccess([OWN_ROOT, SHARED_ROOT], [grant({})], { agentId: "agent-a", caste: null });
    expect(resolved.map((entry) => entry.root.name)).toEqual(["work"]);
  });

  it("lets the most specific grant win", () => {
    const grants = [
      grant({ id: "g-all", rootId: OWN_ROOT.id, targetKind: "all", agentId: null, mode: "ro" }),
      grant({ id: "g-caste", rootId: OWN_ROOT.id, targetKind: "caste", agentId: null, caste: "builders", mode: "ro" }),
      grant({ id: "g-agent", rootId: OWN_ROOT.id, targetKind: "agent", mode: "rw" }),
    ];
    const resolved = resolveAccess([OWN_ROOT], grants, { agentId: "agent-a", caste: "builders" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ mode: "rw", via: "agent" });
  });

  it("ignores a read-write grant on a shared root", () => {
    const resolved = resolveAccess([SHARED_ROOT], [grant({ rootId: SHARED_ROOT.id, mode: "rw" })], {
      agentId: "agent-a",
      caste: null,
    });
    expect(resolved).toHaveLength(0);
  });

  it("ignores a grant whose root no longer exists", () => {
    const resolved = resolveAccess([], [grant({ rootId: "gone" })], { agentId: "agent-a", caste: null });
    expect(resolved).toEqual([]);
  });
});

describe("resolveNamedRoot", () => {
  const roots = [OWN_ROOT, SHARED_ROOT];
  const grants = [grant({}), grant({ id: "g-shared", rootId: SHARED_ROOT.id, targetKind: "all", agentId: null, mode: "ro" })];

  it("resolves a granted root and its effective mode", () => {
    expect(resolveNamedRoot(roots, grants, { agentId: "agent-a", caste: null }, "shared")).toMatchObject({
      mode: "ro",
      via: "all",
    });
  });

  it("returns null for a root the agent was not granted", () => {
    expect(resolveNamedRoot(roots, grants, { agentId: "agent-b", caste: null }, "work")).toBeNull();
  });

  it("returns null for a name that does not exist", () => {
    expect(resolveNamedRoot(roots, grants, { agentId: "agent-a", caste: null }, "nope")).toBeNull();
  });
});

describe("messages and personal roots", () => {
  it("names the boundary in both refusals", () => {
    expect(outsideGrantMessage("secret")).toContain("secret");
    expect(outsideGrantMessage("secret")).toMatch(/not granted/);
    expect(readOnlyMessage("shared")).toMatch(/read-only/);
  });

  it("is read-write only for rw", () => {
    expect(allowsWrite("rw")).toBe(true);
    expect(allowsWrite("ro")).toBe(false);
  });

  it("derives a deterministic personal root", () => {
    expect(personalRootName("Agent-A")).toBe("agent-agent-a");
    expect(personalRootFolder("Agent-A")).toBe("Agents/Agent-A");
  });
});