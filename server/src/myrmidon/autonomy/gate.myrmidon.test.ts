// myrmidon(1.6-AUTONOMY): tests for holdOrAssert functionality
//
// Tests for the holdOrAssert function that handles approval-required actions
// by creating approval cards and holding actions until approved.

import { describe, it, beforeEach, expect, vi, afterEach } from "vitest";
import type { Db } from "@paperclipai/db";
import { autonomyGate, dbAutonomyGate } from "./gate";
import { defaultAutonomyMatrix, AUTONOMY_SAFE_DEFAULTS } from "@paperclipai/shared";
import { eq, and } from "drizzle-orm";
import {
  toolActionRequests,
  toolInvocations,
} from "@paperclipai/db";

// Mock the database
const mockDb = {
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
} as unknown as Db;

describe("autonomyGate.holdOrAssert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow actions when verdict is 'allowed'", async () => {
    const store = {
      read: vi.fn().mockResolvedValue({ matrix: defaultAutonomyMatrix() }),
    };
    const roleOf = vi.fn().mockResolvedValue("admin");

    const gate = autonomyGate({ store, roleOf, db: mockDb });

    // Mock request object
    const mockReq = {
      actor: { type: "agent", agentId: "test-agent-id", companyId: "test-company-id" },
    } as any;

    const result = await gate.holdOrAssert(mockReq, "pause_wake_agents", {
      route: "/agents/test-agent-id/pause",
      method: "POST",
      body: {},
    });

    expect(result).toEqual({ verdict: "allowed" });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("should create approval card when verdict is 'approval_required'", async () => {
    // Create a matrix with approval_required for pause_wake_agents
    const matrixWithApproval = {
      ...defaultAutonomyMatrix(),
      rules: [
        {
          role: "test-role",
          actionClass: "pause_wake_agents" as const,
          verdict: "approval_required" as const,
        }
      ],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS, pause_wake_agents: "approval_required" },
    };

    const store = {
      read: vi.fn().mockResolvedValue({ matrix: matrixWithApproval }),
    };
    const roleOf = vi.fn().mockResolvedValue("test-role");

    const gate = autonomyGate({ store, roleOf, db: mockDb });

    // Mock the insert calls to return test IDs
    mockDb.insert = vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "test-invocation-id" }]),
    }));

    // Mock request object
    const mockReq = {
      actor: { type: "agent", agentId: "test-agent-id", companyId: "test-company-id" },
    } as any;

    const result = await gate.holdOrAssert(mockReq, "pause_wake_agents", {
      route: "/agents/test-agent-id/pause",
      method: "POST",
      body: {},
    });

    expect(result).toEqual({ 
      verdict: "approval_required", 
      held: true, 
      approvalId: expect.any(String) 
    });
    
    // Verify that the tool invocation and action request were created
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it("should throw error when verdict is 'forbidden'", async () => {
    const matrixWithForbidden = {
      ...defaultAutonomyMatrix(),
      rules: [
        {
          role: "test-role",
          actionClass: "pause_wake_agents" as const,
          verdict: "forbidden" as const,
        }
      ],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS, pause_wake_agents: "forbidden" },
    };

    const store = {
      read: vi.fn().mockResolvedValue({ matrix: matrixWithForbidden }),
    };
    const roleOf = vi.fn().mockResolvedValue("test-role");

    const gate = autonomyGate({ store, roleOf, db: mockDb });

    // Mock request object
    const mockReq = {
      actor: { type: "agent", agentId: "test-agent-id" },
      companyId: "test-company-id",
    } as any;

    await expect(gate.holdOrAssert(mockReq, "pause_wake_agents", {
      route: "/agents/test-agent-id/pause",
      method: "POST",
      body: {},
    })).rejects.toThrow("This action is forbidden for this role by the autonomy matrix");
  });

  it("should not create approval card for non-agent callers", async () => {
    const matrixWithApproval = {
      ...defaultAutonomyMatrix(),
      defaults: { ...AUTONOMY_SAFE_DEFAULTS, pause_wake_agents: "approval_required" },
    };

    const store = {
      read: vi.fn().mockResolvedValue({ matrix: matrixWithApproval }),
    };
    const roleOf = vi.fn();

    const gate = autonomyGate({ store, roleOf, db: mockDb });

    // Mock request object for non-agent caller
    const mockReq = {
      actor: { type: "user", userId: "test-user-id" },
    } as any;

    const result = await gate.holdOrAssert(mockReq, "pause_wake_agents", {
      route: "/agents/test-agent-id/pause",
      method: "POST",
      body: {},
    });

    expect(result).toEqual({ verdict: "approval_required" });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});