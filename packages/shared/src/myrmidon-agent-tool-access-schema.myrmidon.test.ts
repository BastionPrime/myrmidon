import { describe, expect, it } from "vitest";
import { updateAgentPermissionsSchema } from "./validators/agent.js";
import {
  agentToolPermissionAllows,
  normalizeAgentToolPermissions,
  readAgentToolPermissions,
} from "./myrmidon-agent-tool-permissions.js";

const base = { canCreateAgents: false, canAssignTasks: false };

describe("myrmidon(S6) operator permission input", () => {
  it("keeps toolAccess through the update schema instead of stripping it", () => {
    const parsed = updateAgentPermissionsSchema.parse({
      ...base,
      toolAccess: { mode: "listed", tools: ["a"], connections: ["c"] },
    });
    expect(parsed.toolAccess).toEqual({ mode: "listed", tools: ["a"], connections: ["c"] });
  });

  it("rejects an unknown mode and leaves toolAccess optional", () => {
    expect(updateAgentPermissionsSchema.safeParse({ ...base, toolAccess: { mode: "some" } }).success).toBe(false);
    expect(updateAgentPermissionsSchema.parse(base).toolAccess).toBeUndefined();
  });

  it("denies unlisted tools, allows listed ones and defaults to allow-all", () => {
    const listed = normalizeAgentToolPermissions({ mode: "listed", tools: ["a"], connections: ["c"] });
    expect(agentToolPermissionAllows(listed, { toolName: "a" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "b", connectionId: "c" })).toBe(true);
    expect(agentToolPermissionAllows(listed, { toolName: "b" })).toBe(false);
    expect(readAgentToolPermissions({}).mode).toBe("all");
    expect(readAgentToolPermissions(null).mode).toBe("all");
  });
});
