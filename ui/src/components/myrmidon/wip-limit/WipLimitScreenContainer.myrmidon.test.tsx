// @vitest-environment jsdom
// myrmidon(1.6.1 WIP-LIMIT B): container-tier tests for the WIP limit screen
// — the wire tier against a mocked API client (part A is not merged yet, so
// the mocks stand in for the frozen contract).
//
// Checked: the settings GET and the status GET fire for the selected company;
// editing + Save PUTs the settings row and invalidates both queries; a
// failing PUT surfaces its message; a failing GET shows the error state; no
// company — the no-company notice, no requests.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { WipLimitScreen } from "./WipLimitScreenContainer";
import type { WipLimitSettings, WipLimitStatusEntry } from "./wipLimitApi";

const wipLimitApiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  putSettings: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("./wipLimitApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wipLimitApi")>()),
  wipLimitApi: wipLimitApiMock,
  wipLimitSettingsQueryKey: (companyId: string) => ["myrmidon", "wip-limit", "settings", companyId],
  wipLimitStatusQueryKey: (companyId: string) => ["myrmidon", "wip-limit", "status", companyId],
}));

const agentsApiMock = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: agentsApiMock }));

let selectedCompanyId = "company-1";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: WipLimitSettings = { defaultLimit: 3, perAgent: { "agent-a": 5 } };
const STATUS: WipLimitStatusEntry[] = [
  { agentId: "agent-a", inProgress: 1, inReview: 1, wip: 2, limit: 5, overLimit: false },
];

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  selectedCompanyId = "company-1";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  wipLimitApiMock.getSettings.mockReset().mockResolvedValue(SETTINGS);
  wipLimitApiMock.putSettings.mockReset().mockResolvedValue(SETTINGS);
  wipLimitApiMock.getStatus.mockReset().mockResolvedValue(STATUS);
  agentsApiMock.list.mockReset().mockResolvedValue([
    { id: "agent-a", name: "Alpha" },
    { id: "agent-b", name: "Beta" },
  ]);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <WipLimitScreen />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function defaultInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("#wip-limit-default")!;
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save WIP limit"),
  )! as HTMLButtonElement;
}

describe("myrmidon(1.6.1 WIP-LIMIT B) container", () => {
  it("loads the settings and the status for the selected company", async () => {
    await renderScreen();
    expect(wipLimitApiMock.getSettings).toHaveBeenCalledWith("company-1");
    expect(wipLimitApiMock.getStatus).toHaveBeenCalledWith("company-1");
    expect(defaultInput().value).toBe("3");
    expect(container.querySelector("[data-testid=wip-limit-status-agent-a]")?.textContent).toContain("1+1 = 2/5");
  });

  it("PUTs the edited settings on save and refetches", async () => {
    await renderScreen();
    const input = defaultInput();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "6");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => saveButton().click());
    await settle();
    expect(wipLimitApiMock.putSettings).toHaveBeenCalledWith("company-1", {
      defaultLimit: 6,
      perAgent: { "agent-a": 5 },
    });
    // invalidation: the settings query ran at least twice (load + refetch)
    expect(wipLimitApiMock.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(wipLimitApiMock.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a PUT error", async () => {
    wipLimitApiMock.putSettings.mockReset().mockRejectedValue(new ApiError("Saving failed", 500, {}));
    await renderScreen();
    await act(async () => saveButton().click());
    await settle();
    expect(container.querySelector("[data-testid=myrmidon-wip-limit-error]")?.textContent).toContain("Saving failed");
  });

  it("shows the error state when the settings GET fails", async () => {
    wipLimitApiMock.getSettings.mockReset().mockRejectedValue(new ApiError("Not found", 404, {}));
    await renderScreen();
    expect(container.querySelector("[data-testid=myrmidon-wip-limit-error]")?.textContent).toContain("Not found");
  });

  it("no company — the notice, no requests", async () => {
    selectedCompanyId = "";
    await renderScreen();
    expect(container.querySelector("[data-testid=myrmidon-wip-limit-no-company]")).not.toBeNull();
    expect(wipLimitApiMock.getSettings).not.toHaveBeenCalled();
    expect(wipLimitApiMock.getStatus).not.toHaveBeenCalled();
  });
});
