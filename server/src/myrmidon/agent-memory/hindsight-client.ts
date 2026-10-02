// server/src/myrmidon/agent-memory/hindsight-client.ts
//
// myrmidon(MEMORY-UI): the board server's thin client for the memory bank
// service. The memory plugin's client (packages/plugins/hindsight-paperclip)
// only knows recall/retain — the card needs the curation surface instead:
// list, invalidate and clear. Transport is injectable so tests never reach a
// real service; no addresses live in this file.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** One memory unit as the card shows it. Unknown fields are kept out. */
export interface HindsightMemoryItem {
  id: string;
  text: string;
  factType: string | null;
  state: string | null;
  occurredAt: string | null;
  createdAt: string | null;
  documentId: string | null;
  tags: string[];
}

export interface HindsightMemoryPage {
  items: HindsightMemoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface HindsightClientDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** A memory the service refused to invalidate (e.g. a derived observation). */
export class HindsightCurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HindsightCurationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse one row of /memories/list; unknown shapes drop to a bare text row. */
export function parseMemoryItem(raw: unknown): HindsightMemoryItem | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = asString(row.id ?? row.memory_id);
  const text = typeof row.text === "string" ? row.text : "";
  if (!id) return null;
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    id,
    text,
    factType: asString(row.fact_type ?? row.type),
    state: asString(row.state),
    occurredAt: asString(row.occurred_start ?? row.occurred_at),
    createdAt: asString(row.created_at),
    documentId: asString(row.document_id),
    tags,
  };
}

/** Parse a /memories/list body: `{ items: [...], total, limit, offset }`. */
export function parseMemoryPage(payload: unknown): HindsightMemoryPage | null {
  const body = asRecord(payload);
  if (!body || !Array.isArray(body.items)) return null;
  const items = body.items.map(parseMemoryItem).filter((item): item is HindsightMemoryItem => item !== null);
  return {
    items,
    total: typeof body.total === "number" ? body.total : items.length,
    limit: typeof body.limit === "number" ? body.limit : items.length,
    offset: typeof body.offset === "number" ? body.offset : 0,
  };
}

export function createMemoryHindsightClient(
  baseUrl: string,
  apiKey: string | undefined,
  deps: HindsightClientDeps = {},
): MemoryHindsightClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        const err = new HindsightCurationError(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`);
        // 400 on PATCH is the service's "cannot curate this unit" answer.
        (err as HindsightCurationError & { status?: number }).status = response.status;
        throw err;
      }
      return text ? (JSON.parse(text) as unknown) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  const bankPath = (bankId: string, suffix: string) =>
    `/v1/default/banks/${encodeURIComponent(bankId)}/memories${suffix}`;

  return {
    async list(bankId: string, opts: { limit?: number; offset?: number; state?: string } = {}) {
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (opts.state) params.set("state", opts.state);
      const payload = await request("GET", `${bankPath(bankId, "/list")}?${params.toString()}`);
      const page = parseMemoryPage(payload);
      if (!page) throw new Error("memory service answered in an unexpected shape");
      return page;
    },
    async invalidate(bankId: string, memoryId: string, reason: string) {
      await request("PATCH", bankPath(bankId, `/${encodeURIComponent(memoryId)}`), {
        state: "invalidated",
        reason,
      });
    },
    async clear(bankId: string) {
      const payload = await request("DELETE", bankPath(bankId, ""));
      const body = asRecord(payload);
      const deletedCount = body && typeof body.deleted_count === "number" ? body.deleted_count : null;
      return { deletedCount };
    },
  };
}

export interface MemoryHindsightClient {
  list(bankId: string, opts?: { limit?: number; offset?: number; state?: string }): Promise<HindsightMemoryPage>;
  invalidate(bankId: string, memoryId: string, reason: string): Promise<void>;
  clear(bankId: string): Promise<{ deletedCount: number | null }>;
}
