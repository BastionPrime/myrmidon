// myrmidon(L3): `ctx.agents.resume` is a first-class, documented plugin
// capability (packages/plugins/sdk/src/types.ts) with its own production
// caller path, entirely separate from the operator HTTP route
// (POST /agents/:id/resume). Before this fix, resuming an agent through a
// plugin flipped its status back to idle but never woke its queued runs or
// stranded assigned issues — this test exercises that second entrypoint.
import { describe, expect, it, vi } from "vitest";

const mockAgentGetById = vi.hoisted(() => vi.fn());
const mockAgentPause = vi.hoisted(() => vi.fn());
const mockAgentResume = vi.hoisted(() => vi.fn());
const mockAgentService = vi.hoisted(() => vi.fn(() => ({
  getById: mockAgentGetById,
  pause: mockAgentPause,
  resume: mockAgentResume,
})));

vi.mock("../services/agents.js", () => ({
  agentService: mockAgentService,
}));

const mockWakeup = vi.hoisted(() => vi.fn());
const mockResumeAgentAfterPause = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => vi.fn(() => ({
  wakeup: mockWakeup,
  resumeAgentAfterPause: mockResumeAgentAfterPause,
})));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: mockHeartbeatService,
}));

import { buildHostServices } from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

const companyId = "company-a";
const agentId = "agent-a";

function buildAgentsClient() {
  return buildHostServices({} as never, "plugin-record-id", "example.plugin", createEventBusStub()).agents;
}

describe("plugin host services: agents.resume wakes stranded work (L3)", () => {
  it("calls resumeAgentAfterPause after a successful resume", async () => {
    mockAgentGetById.mockReset().mockResolvedValue({ id: agentId, companyId });
    mockAgentResume.mockReset().mockResolvedValue({ id: agentId, companyId, status: "idle" });
    mockResumeAgentAfterPause.mockReset().mockResolvedValue({ queuedRunsPromoted: 1, strandedIssuesWoken: 2 });

    const agents = buildAgentsClient();
    const result = await agents.resume({ agentId, companyId });

    expect(result).toEqual({ id: agentId, companyId, status: "idle" });
    expect(mockAgentResume).toHaveBeenCalledWith(agentId);
    expect(mockResumeAgentAfterPause).toHaveBeenCalledWith(agentId);
  });

  it("still returns the resumed agent when the wake fails (best-effort)", async () => {
    mockAgentGetById.mockReset().mockResolvedValue({ id: agentId, companyId });
    mockAgentResume.mockReset().mockResolvedValue({ id: agentId, companyId, status: "idle" });
    mockResumeAgentAfterPause.mockReset().mockRejectedValue(new Error("wake boom"));

    const agents = buildAgentsClient();
    await expect(agents.resume({ agentId, companyId })).resolves.toEqual({
      id: agentId,
      companyId,
      status: "idle",
    });
    expect(mockResumeAgentAfterPause).toHaveBeenCalledWith(agentId);
  });

  it("does not wake when the agent is not in the calling company", async () => {
    mockAgentGetById.mockReset().mockResolvedValue({ id: agentId, companyId: "other-company" });
    mockAgentResume.mockReset();
    mockResumeAgentAfterPause.mockReset();

    const agents = buildAgentsClient();
    await expect(agents.resume({ agentId, companyId })).rejects.toThrow();
    expect(mockAgentResume).not.toHaveBeenCalled();
    expect(mockResumeAgentAfterPause).not.toHaveBeenCalled();
  });
});
