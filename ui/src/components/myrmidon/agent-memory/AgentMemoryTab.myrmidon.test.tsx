// @vitest-environment jsdom
//
// myrmidon(MEMORY-UI): the Memory tab of the agent card — status line, list,
// remove with a reason, and the guarded clear action.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryTabView } from "./AgentMemoryTab";
import type { MemoryCardStatus, MemoryPageView } from "./memoryApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const AGENT = "33333333-3333-4333-8333-333333333333";

const status: MemoryCardStatus = {
  enabled: true,
  bank: { bankId: "adm", source: "agent-card" },
  reason: null,
};

const page: MemoryPageView = {
  items: [
    {
      id: "m1",
      text: "likes tea",
      factType: "world",
      state: "valid",
      occurredAt: null,
      createdAt: "2026-09-01T00:00:00Z",
      documentId: null,
      tags: ["channel:board"],
    },
    {
      id: "m2",
      text: "server decommissioned",
      factType: "experience",
      state: "invalidated",
      occurredAt: null,
      createdAt: "2026-09-02T00:00:00Z",
      documentId: null,
      tags: [],
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

function render(overrides: Partial<Parameters<typeof AgentMemoryTabView>[0]> = {}) {
  const props = {
    agentId: AGENT,
    status,
    page,
    pageError: null as unknown,
    pending: false,
    actionError: null,
    actionNotice: null,
    onDelete: vi.fn(),
    onClear: vi.fn(),
    onExport: vi.fn(),
    exportPending: false,
    offset: 0,
    onOffsetChange: vi.fn(),
    ...overrides,
  };
  flushSync(() => root.render(<AgentMemoryTabView {...props} />));
  return props;
}

function text(): string {
  return container.textContent ?? "";
}

describe("AgentMemoryTabView", () => {
  it("shows the bank and its source", () => {
    render();
    expect(text()).toContain("Bank adm (from the agent card).");
  });

  it("says why the section is off or bank-less", () => {
    render({ status: { enabled: false, bank: null, reason: "not_enabled" } });
    expect(text()).toContain("Agent memory is not enabled on this instance.");
    render({ status: { enabled: true, bank: null, reason: "no_bank" } });
    expect(text()).toContain("This agent has no memory bank configured");
  });

  it("lists entries with type, state and date", () => {
    render();
    expect(container.querySelector('[data-testid="myrmidon-agent-memory-item-m1"]')?.textContent).toContain("likes tea");
    expect(text()).toContain("world");
    expect(text()).toContain("channel:board");
  });

  it("an invalidated entry shows no remove form", () => {
    render();
    const invalidated = container.querySelector('[data-testid="myrmidon-agent-memory-item-m2"]')!;
    expect(invalidated.querySelector("input")).toBeNull();
  });

  it("remove requires a reason and forwards it", () => {
    const props = render();
    const input = container.querySelector('input[aria-label^="Reason for removing memory m1"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(input, "stale");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Remove"));
    expect(buttons).toHaveLength(1);
    flushSync(() => buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(props.onDelete).toHaveBeenCalledWith("m1", "stale");
  });

  it("clear stays disabled until the agent id is typed", () => {
    const props = render();
    const button = container.querySelector('[data-testid="myrmidon-agent-memory-clear-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const input = container.querySelector('[data-testid="myrmidon-agent-memory-clear-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(input, AGENT);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button.disabled).toBe(false);
    flushSync(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(props.onClear).toHaveBeenCalledWith(AGENT);
  });

  it("shows an empty state for an empty bank", () => {
    render({ page: { ...page, items: [], total: 0 } });
    expect(text()).toContain("No memories in this bank");
  });

  it("surfaces action errors and notices", () => {
    render({ actionError: "Request failed: 503" });
    expect(container.querySelector('[data-testid="myrmidon-agent-memory-error"]')?.textContent).toContain("503");
    render({ actionNotice: "Bank cleared (2 entries removed)." });
    expect(container.querySelector('[data-testid="myrmidon-agent-memory-notice"]')?.textContent).toContain("Bank cleared");
  });
});
