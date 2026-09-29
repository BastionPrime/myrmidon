/**
 * Hindsight API client (fork of the upstream 0.3.0 client).
 *
 * The transport is injectable so the plugin's unit tests never talk to a real
 * Hindsight service: tests pass a mock fetch, the worker passes nothing and
 * gets the global fetch. No addresses are built into this file.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetainMetadata {
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    token?: string,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    const url = baseUrl.trim();
    if (!url) throw new Error("hindsightApiUrl is required");
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    return headers;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} from ${path}: ${text}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(
    bankId: string,
    query: string,
    budget: string = "mid",
  ): Promise<{ results: Array<{ text: string }> }> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    const response = await this.request("POST", path, {
      query,
      budget,
      max_tokens: 1024,
    });
    return (response ?? { results: [] }) as { results: Array<{ text: string }> };
  }

  async retain(
    bankId: string,
    content: string,
    documentId: string | undefined,
    metadata: RetainMetadata | undefined,
  ): Promise<void> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item: Record<string, unknown> = {
      content,
      context: "paperclip",
    };
    if (documentId) item["document_id"] = documentId;
    if (metadata) item["metadata"] = metadata;
    await this.request("POST", path, { items: [item], async: true });
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function formatMemories(memories: Array<{ text: string }>): string {
  if (memories.length === 0) return "";
  return memories.map((memory) => `- ${memory.text}`).join("\n");
}
