// myrmidon(1.6-FORAGE): the reader's host discipline — minimum pause between two
// reads of one host, and a breaker that leaves a repeatedly failing host alone.
// A fake fetch stands in for the network (neutral host: example.com).
import { describe, expect, it, vi } from "vitest";
import { createForagingReader, resetForagingHostState } from "./reader.js";
import type { ForagingSourceRef } from "./domain.js";

function source(url: string): ForagingSourceRef {
  return {
    id: "s1",
    companyId: "company-a",
    role: "engineer",
    url,
    kind: "url",
    enabled: true,
    lastSnapshot: null,
  };
}

describe("myrmidon(1.6-FORAGE) reader", () => {
  it("reads a source and caps the answer", async () => {
    resetForagingHostState();
    const fetchImpl = vi.fn(async () => new Response("hello\nworld", { status: 200 }));
    const reader = createForagingReader({ minHostIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000_000 });
    const result = await reader.read(source("https://example.com/a"), new AbortController().signal);
    expect(result.text).toBe("hello\nworld");
    expect(result.bytes).toBe(11);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("myrmidon-foraging");
  });

  it("refuses a second read of the same host inside the minimum interval", async () => {
    resetForagingHostState();
    const fetchImpl = vi.fn(async () => new Response("a", { status: 200 }));
    let clock = 5_000_000;
    const reader = createForagingReader({
      minHostIntervalMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    await reader.read(source("https://example.com/a"), new AbortController().signal);
    await expect(reader.read(source("https://example.com/b"), new AbortController().signal)).rejects.toThrow(
      /minimum interval/,
    );
    clock += 60_001;
    await expect(reader.read(source("https://example.com/b"), new AbortController().signal)).resolves.toBeDefined();
  });

  it("opens the breaker after repeated failures and leaves the host alone", async () => {
    resetForagingHostState();
    const fetchImpl = vi.fn(async () => new Response("down", { status: 500 }));
    let clock = 9_000_000;
    const reader = createForagingReader({
      minHostIntervalMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    await expect(reader.read(source("https://example.com/a"), new AbortController().signal)).rejects.toThrow(/500/);
    clock += 1;
    await expect(reader.read(source("https://example.com/a"), new AbortController().signal)).rejects.toThrow(/500/);
    clock += 1;
    await expect(reader.read(source("https://example.com/a"), new AbortController().signal)).rejects.toThrow(/paused/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("adds a bearer header only when a key is configured for the company", async () => {
    resetForagingHostState();
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));
    const reader = createForagingReader({
      minHostIntervalMs: 0,
      env: { MYRMIDON_FORAGING_KEY_SECRET: "SOURCE_READ_TOKEN" } as NodeJS.ProcessEnv,
      readKey: async () => "key-value",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 12_000_000,
    });
    await reader.read(source("https://example.com/a"), new AbortController().signal);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-value");
  });
});