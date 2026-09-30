import { describe, expect, it } from "vitest";

import {
  buildEgressPolicyDocument,
  EgressPolicyInputError,
  effectiveProjectEgressMode,
  formatEgressDestination,
  parseEgressAllowlist,
  parseEgressDestination,
  projectPolicySaveRefusal,
  readBotEgressPolicy,
  readProjectEgressPolicy,
  type EgressPolicyRow,
} from "./egress-policy.js";

// Placeholder data only: example.com hosts and fake bot keys.

function projectRow(overrides: Partial<EgressPolicyRow> = {}): EgressPolicyRow {
  return {
    scope: "project",
    targetId: "00000000-0000-4000-8000-0000000000a1",
    mode: "log",
    verified: false,
    allow: [],
    project: "example-project",
    ...overrides,
  };
}

function botRow(overrides: Partial<EgressPolicyRow> = {}): EgressPolicyRow {
  return {
    scope: "bot",
    targetId: "agent-a",
    mode: null,
    verified: null,
    allow: [],
    project: "example-project",
    ...overrides,
  };
}

describe("myrmidon(EGRESS-B) parseEgressDestination", () => {
  it("reads a bare host as every port on it", () => {
    expect(parseEgressDestination("api.example.com")).toEqual({ host: "api.example.com", port: null });
    expect(parseEgressDestination("  API.Example.COM  ")).toEqual({ host: "api.example.com", port: null });
  });

  it("reads host:port and the well-known port of a URL", () => {
    expect(parseEgressDestination("api.example.com:8443")).toEqual({ host: "api.example.com", port: 8443 });
    expect(parseEgressDestination("https://api.example.com")).toEqual({ host: "api.example.com", port: 443 });
    expect(parseEgressDestination("http://api.example.com:8080")).toEqual({ host: "api.example.com", port: 8080 });
    expect(parseEgressDestination("api.example.com:*")).toEqual({ host: "api.example.com", port: null });
  });

  it("refuses anything that is not a destination, instead of storing a pattern", () => {
    for (const bad of ["", "  ", "*.example.com", "api.example.com/path", "api.example.com?x=1", "host with space", "a:b:c", "api.example.com:0", "api.example.com:70000", "api.example.com:https", "https://api.example.com/path"]) {
      expect(parseEgressDestination(bad), bad).toBeNull();
    }
  });

  it("round-trips through the stored form", () => {
    expect(formatEgressDestination({ host: "api.example.com", port: null })).toBe("api.example.com");
    expect(formatEgressDestination({ host: "api.example.com", port: 443 })).toBe("api.example.com:443");
  });
});

describe("myrmidon(EGRESS-B) parseEgressAllowlist", () => {
  it("reads the list in order and drops repeats", () => {
    expect(parseEgressAllowlist(["api.example.com:443", "https://API.example.com", "other.example.com:8080"])).toEqual([
      { host: "api.example.com", port: 443 },
      { host: "other.example.com", port: 8080 },
    ]);
  });

  it("treats a missing value as an empty list", () => {
    expect(parseEgressAllowlist(null)).toEqual([]);
    expect(parseEgressAllowlist(undefined)).toEqual([]);
    expect(parseEgressAllowlist([])).toEqual([]);
  });

  it("throws on a value that cannot be a list, rather than reading it as empty", () => {
    expect(() => parseEgressAllowlist("api.example.com")).toThrow(EgressPolicyInputError);
    expect(() => parseEgressAllowlist([42])).toThrow(/entries must be strings/);
    expect(() => parseEgressAllowlist(["*.example.com"])).toThrow(/not a destination/);
  });
});

describe("myrmidon(EGRESS-B) mode and the verified gate", () => {
  it("defaults a project to recording", () => {
    expect(readProjectEgressPolicy(null)).toEqual({ mode: "log", verified: false, allow: [] });
    expect(effectiveProjectEgressMode(readProjectEgressPolicy(null))).toBe("log");
  });

  it("sends block only with a verified, non-empty list", () => {
    const allow = [{ host: "api.example.com", port: null }];
    expect(effectiveProjectEgressMode({ mode: "block", verified: true, allow })).toBe("block");
    expect(effectiveProjectEgressMode({ mode: "block", verified: false, allow })).toBe("log");
    expect(effectiveProjectEgressMode({ mode: "block", verified: true, allow: [] })).toBe("log");
    expect(effectiveProjectEgressMode({ mode: "log", verified: true, allow })).toBe("log");
  });

  it("names why a save into block is refused", () => {
    const allow = [{ host: "api.example.com", port: null }];
    expect(projectPolicySaveRefusal({ mode: "log", verified: false, allow: [] })).toBeNull();
    expect(projectPolicySaveRefusal({ mode: "block", verified: false, allow })).toMatch(/verified/);
    expect(projectPolicySaveRefusal({ mode: "block", verified: true, allow: [] })).toMatch(/at least one allowed destination/);
    expect(projectPolicySaveRefusal({ mode: "block", verified: true, allow })).toBeNull();
  });

  it("reads an unknown stored mode as recording, and the bot's project as typed", () => {
    expect(readProjectEgressPolicy(projectRow({ mode: "refuse" })).mode).toBe("log");
    expect(readBotEgressPolicy(botRow({ project: " example-project " })).project).toBe("example-project");
    expect(readBotEgressPolicy(null)).toEqual({ project: "", allow: [] });
  });
});

describe("myrmidon(EGRESS-B) buildEgressPolicyDocument", () => {
  it("keys bots by their key and projects by the journal's project name", () => {
    const document = buildEgressPolicyDocument([
      projectRow({ mode: "block", verified: true, allow: ["api.example.com"], project: "example-project" }),
      botRow({ targetId: "agent-a", project: "example-project", allow: ["extra.example.com:8443"] }),
    ]);
    expect(document.version).toBe(1);
    expect(document.bots).toEqual({
      "agent-a": { project: "example-project", allow: ["extra.example.com:8443"] },
    });
    expect(document.projects).toEqual({
      "example-project": { mode: "block", allow: ["api.example.com"] },
    });
  });

  it("publishes log when the stored row is not allowed to block", () => {
    const document = buildEgressPolicyDocument([
      projectRow({ mode: "block", verified: false, allow: ["api.example.com"] }),
    ]);
    expect(document.projects["example-project"].mode).toBe("log");
  });

  it("skips a project row the journal could never name", () => {
    const document = buildEgressPolicyDocument([projectRow({ project: "  " })]);
    expect(document.projects).toEqual({});
  });

  it("ignores rows of a scope it does not know", () => {
    const document = buildEgressPolicyDocument([projectRow({ scope: "instance", project: "example-project" })]);
    expect(document.projects).toEqual({});
    expect(document.bots).toEqual({});
  });
});