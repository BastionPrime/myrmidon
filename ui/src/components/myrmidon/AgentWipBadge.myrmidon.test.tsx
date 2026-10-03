// @vitest-environment jsdom
//
// myrmidon(1.6.1 WIP-LIMIT B): the per-agent WIP badge on the agents list.
// The status endpoint (part A contract) is mocked; the view itself is pure.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentWipBadge, AgentWipBadgeView } from "./AgentWipBadge";
import { wipLimitApi, type WipLimitStatusRow } from "@/api/wipLimit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/wipLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/wipLimit")>();
  return { ...actual, wipLimitApi: { status: vi.fn() } };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

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
  vi.mocked(wipLimitApi.status).mockReset();
});

const row = (overrides: Partial<WipLimitStatusRow>): WipLimitStatusRow => ({
  agentId: "agent-1",
  inProgress: 1,
  inReview: 1,
  wip: 2,
  limit: 3,
  overLimit: false,
  ...overrides,
});

function renderBadge(r: WipLimitStatusRow) {
  flushSync(() => {
    root.render(<AgentWipBadgeView row={r} />);
  });
}

function badge(): HTMLElement | null {
  return container.querySelector("[data-testid='agent-wip-badge']");
}

function renderHooked(agentId: string, queryClient: QueryClient) {
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentWipBadge agentId={agentId} />
      </QueryClientProvider>,
    );
  });
}

describe("myrmidon(1.6.1 WIP-LIMIT-B) agent card badge", () => {
  it("shows wip/limit for an agent under its limit", () => {
    renderBadge(row({}));
    expect(badge()!.textContent).toBe("2/3");
    expect(badge()!.getAttribute("data-over-limit")).toBe("false");
  });

  it("shows the over-limit state when the server flags it", () => {
    renderBadge(row({ wip: 5, overLimit: true }));
    expect(badge()!.textContent).toContain("5/3");
    expect(badge()!.textContent).toContain("over");
    expect(badge()!.getAttribute("data-over-limit")).toBe("true");
  });

  it("derives over-limit from the numbers when the flag is missing", () => {
    renderBadge(row({ wip: 4, overLimit: false }));
    expect(badge()!.getAttribute("data-over-limit")).toBe("true");
  });

  it("shows the raw load without a limit set", () => {
    renderBadge(row({ limit: null }));
    expect(badge()!.textContent).toBe("2 wip");
    expect(badge()!.getAttribute("data-over-limit")).toBeNull();
  });

  it("renders nothing for an agent without a status row", async () => {
    vi.mocked(wipLimitApi.status).mockResolvedValue([
      row({ agentId: "other-agent" }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHooked("agent-1", queryClient);
    await vi.waitFor(() => expect(wipLimitApi.status).toHaveBeenCalled());
    renderHooked("agent-1", queryClient);
    expect(badge()).toBeNull();
  });

  it("renders the badge for an agent with a status row", async () => {
    vi.mocked(wipLimitApi.status).mockResolvedValue([row({})]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHooked("agent-1", queryClient);
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.textContent).toBe("2/3");
  });
});
