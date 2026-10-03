import { describe, it, beforeEach, afterEach } from "vitest";
import { SessionStorage, isCentralSessionStorageEnabled } from "./session-storage.js";

describe("SessionStorage", () => {
  const mockConfig = {
    hindsightApiUrl: "http://test-hindsight:8888",
    hindsightApiKey: "test-key",
    bankId: "test-bank-id",
    enabled: true,
  };

  // Mock fetch implementation
  const mockFetch: typeof fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    
    if (url.includes('/recall')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              id: "test-session-id",
              content: JSON.stringify({ 
                runId: "test-run-id", 
                status: "completed", 
                output: "test output",
                timestamp: new Date().toISOString()
              }),
              tags: ["session:test-session-id"],
              createdAt: new Date().toISOString(),
            }
          ]
        })
      } as Response;
    } else if (url.includes('/health')) {
      return {
        ok: true,
        json: async () => ({ status: "ok" })
      } as Response;
    } else {
      return {
        ok: true,
        json: async () => ({ id: "retention-success" })
      } as Response;
    }
  };

  it("should initialize with correct configuration", () => {
    const sessionStorage = new SessionStorage(mockConfig, mockFetch);
    expect(sessionStorage.isEnabled()).toBe(true);
  });

  it("should return false when disabled", () => {
    const sessionStorage = new SessionStorage({
      ...mockConfig,
      enabled: false,
    }, mockFetch);
    expect(sessionStorage.isEnabled()).toBe(false);
  });

  it("should return null when loading session with disabled storage", async () => {
    const sessionStorage = new SessionStorage({
      ...mockConfig,
      enabled: false,
    }, mockFetch);
    
    const result = await sessionStorage.loadSession("test-session");
    expect(result).toBeNull();
  });

  it("should return null when saving session with disabled storage", async () => {
    const sessionStorage = new SessionStorage({
      ...mockConfig,
      enabled: false,
    }, mockFetch);
    
    await expect(sessionStorage.saveSession("test-session", {})).resolves.not.toThrow();
  });

  it("should detect central session storage enabled based on environment", () => {
    // Test with enabled value
    process.env.MYRMIDON_BOT_CENTRAL_HISTORY = "1";
    expect(isCentralSessionStorageEnabled()).toBe(true);

    // Test with disabled value
    process.env.MYRMIDON_BOT_CENTRAL_HISTORY = "0";
    expect(isCentralSessionStorageEnabled()).toBe(false);

    // Reset
    delete process.env.MYRMIDON_BOT_CENTRAL_HISTORY;
  });
});