// server/src/myrmidon/litellm-sync/litellm-sync.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): tests for LiteLLM synchronization.
//
// Tests the core functionality:
// - enable → calls /model/new
// - disable → calls /model/delete
// - startup → reconcile differences
// - credential rotation updates all provider models
// - secret values are not exposed in logs/payloads

import { describe, it, expect, beforeEach, vi, MockedFunction } from "vitest";
import { createLitellmSyncService, type LitellmSyncServiceDeps } from "./service.js";
import type { LitellmSyncPort } from "./port.js";
import type { Db } from "@paperclipai/db";

// Mock implementations for testing
const mockLitellmPort: jest.Mocked<LitellmSyncPort> = {
  registerModel: vi.fn().mockResolvedValue(undefined),
  unregisterModel: vi.fn().mockResolvedValue(undefined),
  listRegisteredModels: vi.fn().mockResolvedValue([]),
};

const mockDb: jest.Mocked<Db> = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe("LitellmSyncService", () => {
  let deps: LitellmSyncServiceDeps;
  let service: ReturnType<typeof createLitellmSyncService>;

  beforeEach(() => {
    vi.clearAllMocks();
    
    deps = {
      db: mockDb,
      litellm: mockLitellmPort,
    };
    
    service = createLitellmSyncService(deps);
  });

  it("registers model when enabled", async () => {
    // Mock DB responses for provider and model
    (mockDb.select as MockedFunction<any>).mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ 
        id: "prov-123", 
        type: "openai", 
        baseUrl: "https://api.openai.com/v1",
        credentialSecretName: "secret-name-123"
      }]),
    });
    
    (mockDb.select as MockedFunction<any>).mockReturnValueOnce({
      limit: vi.fn().mockResolvedValue([{ 
        litellmModelName: "openai/gpt-4o" 
      }]),
    });

    await service.syncModel("prov-123", "gpt-4o", true);

    expect(mockLitellmPort.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "secret-name-123",
    });
    expect(mockLitellmPort.unregisterModel).not.toHaveBeenCalled();
  });

  it("unregisters model when disabled", async () => {
    // Mock DB responses for provider and model
    (mockDb.select as MockedFunction<any>).mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ 
        litellmModelName: "openai/gpt-4o" 
      }]),
    });

    await service.syncModel("prov-123", "gpt-4o", false);

    expect(mockLitellmPort.unregisterModel).toHaveBeenCalledWith("openai/gpt-4o");
    expect(mockLitellmPort.registerModel).not.toHaveBeenCalled();
  });

  it("reconciles models at startup", async () => {
    // Mock DB response for enabled models
    (mockDb.select as MockedFunction<any>).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
    });
    
    // Mock the chained call that returns the enabled models
    const mockQueryResult = [{
      litellmModelName: "openai/gpt-4o",
      provider: {
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        credentialSecretName: "secret-name-123",
      }
    }];
    
    const mockQueryBuilder = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockQueryResult),
    };
    
    (mockDb.select as MockedFunction<any>).mockReturnValue(mockQueryBuilder);
    
    // Mock LiteLLM to return no current registrations (need to register all DB enabled)
    mockLitellmPort.listRegisteredModels.mockResolvedValue([]);

    await service.reconcileWithLitellm();

    // Should register all enabled models from DB that aren't in LiteLLM
    expect(mockLitellmPort.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "secret-name-123",
    });
  });

  it("handles credential rotation for all provider models", async () => {
    // Mock DB responses
    (mockDb.select as MockedFunction<any>)
      .mockReturnValueOnce({  // First call: provider lookup
        limit: vi.fn().mockResolvedValue([{ 
          id: "prov-123", 
          type: "openai", 
          baseUrl: "https://api.openai.com/v1",
          credentialSecretName: "new-secret-name-456",
          companyId: "comp-789"
        }])
      })
      .mockReturnValueOnce({  // Second call: enabled models lookup
        where: vi.fn().mockReturnThis(),
        and: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          { litellmModelName: "openai/gpt-4o" },
          { litellmModelName: "openai/gpt-4-turbo" }
        ])
      });

    await service.handleProviderCredentialRotation("comp-789", "prov-123");

    // Should unregister and re-register each enabled model with new credentials
    expect(mockLitellmPort.unregisterModel).toHaveBeenCalledTimes(2);
    expect(mockLitellmPort.registerModel).toHaveBeenCalledTimes(2);
    
    expect(mockLitellmPort.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "new-secret-name-456",
    });
    
    expect(mockLitellmPort.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4-turbo",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "new-secret-name-456",
    });
  });

  it("does not expose secret values in registerModel calls", async () => {
    // Mock DB responses
    (mockDb.select as MockedFunction<any>).mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ 
        id: "prov-123", 
        type: "openai", 
        baseUrl: "https://api.openai.com/v1",
        credentialSecretName: "secret-name-123"  // This is the SECRET NAME, not the value
      }]),
    });
    
    (mockDb.select as MockedFunction<any>).mockReturnValueOnce({
      limit: vi.fn().mockResolvedValue([{ 
        litellmModelName: "openai/gpt-4o" 
      }]),
    });

    await service.syncModel("prov-123", "gpt-4o", true);

    const callArgs = mockLitellmPort.registerModel.mock.calls[0][0];
    // Verify that the credentialSecretName is a reference, not the actual secret value
    expect(callArgs.credentialSecretName).toBe("secret-name-123");
    // The actual secret value should never be passed to LiteLLM
    expect(callArgs).not.toHaveProperty("credentialValue");
  });
});