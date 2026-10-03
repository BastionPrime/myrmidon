import type { FetchLike } from "../../../../plugins/hindsight-paperclip/src/client.js";
import { HindsightClient } from "../../../../plugins/hindsight-paperclip/src/client.js";

/**
 * Central session storage using hindsight for hermes gateway sessions.
 * When enabled via MYRMIDON_BOT_CENTRAL_HISTORY, stores session data in 
 * the central hindsight store instead of relying on container volumes.
 */
export interface SessionStorageConfig {
  hindsightApiUrl: string;
  hindsightApiKey?: string;
  bankId: string;
  enabled: boolean;
}

export class SessionStorage {
  private client: HindsightClient | null = null;
  private readonly enabled: boolean;

  constructor(private config: SessionStorageConfig, private fetchImpl?: FetchLike) {
    this.enabled = config.enabled && !!config.hindsightApiUrl && !!config.bankId;
    if (this.enabled) {
      this.client = new HindsightClient(
        config.hindsightApiUrl, 
        config.hindsightApiKey, 
        fetchImpl
      );
    }
  }

  /**
   * Loads session data from central storage by session ID
   */
  async loadSession(sessionId: string): Promise<Record<string, unknown> | null> {
    if (!this.enabled || !this.client) {
      return null;
    }

    try {
      // Search for session data in hindsight using the session ID as a tag
      const response = await this.client.recall(
        this.config.bankId,
        `session:${sessionId}`,
        "high"
      );

      if (response.results && response.results.length > 0) {
        // Find the most recent session entry
        const sessionResult = response.results[0];
        if (sessionResult.content) {
          try {
            // Session data is stored as JSON
            return JSON.parse(sessionResult.content);
          } catch {
            // If parsing fails, return null
            return null;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.warn(`Failed to load session ${sessionId} from central storage:`, error);
      return null;
    }
  }

  /**
   * Saves session data to central storage
   */
  async saveSession(sessionId: string, sessionData: Record<string, unknown>): Promise<void> {
    if (!this.enabled || !this.client) {
      return;
    }

    try {
      const content = JSON.stringify(sessionData);
      await this.client.retain(
        this.config.bankId,
        content,
        `session_${sessionId}_${Date.now()}`, // Unique ID for this retention
        {
          sessionId,
          type: "hermes_gateway_session",
          timestamp: new Date().toISOString(),
        }
      );
    } catch (error) {
      console.warn(`Failed to save session ${sessionId} to central storage:`, error);
    }
  }

  /**
   * Checks if central session storage is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Determines if central session storage is enabled based on environment/config
 */
export function isCentralSessionStorageEnabled(): boolean {
  const enabledFlag = process.env.MYRMIDON_BOT_CENTRAL_HISTORY;
  return enabledFlag !== undefined && 
         enabledFlag !== "0" && 
         enabledFlag !== "false" && 
         enabledFlag !== "no" && 
         enabledFlag !== "off";
}