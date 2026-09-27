import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  getEffectiveProfilesForAgent: vi.fn(),
}));

vi.mock("../agent-instructions.js", () => ({
  agentInstructionsService: () => ({ exportFiles: vi.fn() }),
}));

vi.mock("../tool-access.js", () => ({
  toolAccessService: () => ({
    getEffectiveProfilesForAgent: serviceMocks.getEffectiveProfilesForAgent,
  }),
}));

import { resolveNativeRuntimeMcpSnapshot } from "./runtime-context.js";

function digestOf(connections: string[], tools: string[]) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, agentId: "agent-a", connections, tools }))
    .digest("hex");
}

describe("native runtime MCP selection (myrmidon P9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["degraded", "error", "missing_secret", "failed"])(
    "keeps an assigned connection whose health is %s",
    async (healthStatus) => {
      serviceMocks.getEffectiveProfilesForAgent.mockResolvedValue({
        agentId: "agent-a",
        profiles: [],
        entries: [
          { effect: "include", connectionId: "connection-unhealthy" },
          { effect: "include", connectionId: "connection-healthy" },
        ],
        bindings: [],
        allowedTools: [
          { id: "tool-unhealthy", connectionId: "connection-unhealthy" },
          { id: "tool-healthy", connectionId: "connection-healthy" },
        ],
        allowedToolNames: ["unhealthy.read", "healthy.read"],
        installedConnections: [
          { id: "connection-unhealthy", transport: "mcp_remote", enabled: true, status: "active", healthStatus },
          { id: "connection-healthy", transport: "mcp_remote", enabled: true, status: "active", healthStatus: "healthy" },
        ],
      });

      const snapshot = await resolveNativeRuntimeMcpSnapshot({
        db: {} as Db,
        agent: { id: "agent-a", companyId: "company-a" },
        runId: "run-a",
      });

      expect(snapshot.digest).toBe(
        digestOf(["connection-healthy", "connection-unhealthy"], ["tool-healthy", "tool-unhealthy"]),
      );
      expect(snapshot.bindingId).toBe("native-mcp:run-a");
    },
  );

  it("still leaves out a disabled connection", async () => {
    serviceMocks.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-a",
      profiles: [],
      entries: [
        { effect: "include", connectionId: "connection-disabled" },
        { effect: "include", connectionId: "connection-healthy" },
      ],
      bindings: [],
      allowedTools: [
        { id: "tool-disabled", connectionId: "connection-disabled" },
        { id: "tool-healthy", connectionId: "connection-healthy" },
      ],
      allowedToolNames: ["disabled.read", "healthy.read"],
      installedConnections: [
        { id: "connection-disabled", transport: "mcp_remote", enabled: false, status: "disabled", healthStatus: "healthy" },
        { id: "connection-healthy", transport: "mcp_remote", enabled: true, status: "active", healthStatus: "healthy" },
      ],
    });

    const snapshot = await resolveNativeRuntimeMcpSnapshot({
      db: {} as Db,
      agent: { id: "agent-a", companyId: "company-a" },
      runId: "run-a",
    });

    expect(snapshot.digest).toBe(digestOf(["connection-healthy"], ["tool-healthy"]));
  });
});
