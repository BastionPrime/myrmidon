// ui/src/ui2/screens/costs/Ui2Costs.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for the Costs screen. Parity: the tiles and
// tables render from mocked costs/budgets APIs; the legacy incident
// resolution actions (keep paused / raise budget and resume) stay
// reachable with the same payload the vendor screen sends. Red side: with
// the ui2 screen absent, these assertions fail.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2Costs } from "./Ui2Costs";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";

const mockCostsApi = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
}));

vi.mock("@/api/costs", () => ({
  costsApi: mockCostsApi,
}));

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  resolveIncident: vi.fn(),
}));

vi.mock("@/api/budgets", () => ({
  budgetsApi: mockBudgetsApi,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "company-a", issuePrefix: "OPE" },
  }),
}));

const COMPANY_ID = "company-1";

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2Costs screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2Costs />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockCostsApi.summary.mockResolvedValue({
      companyId: COMPANY_ID,
      spendCents: 157_400,
      budgetCents: 220_000,
      utilizationPercent: 71.5,
    });
    mockCostsApi.byAgent.mockResolvedValue([
      {
        agentId: "agent-1",
        agentName: "agent-a",
        agentStatus: "active",
        costCents: 62_310,
        inputTokens: 4_812_000,
        cachedInputTokens: 1_200_000,
        outputTokens: 918_000,
        apiRunCount: 41,
        subscriptionRunCount: 3,
        subscriptionCachedInputTokens: 0,
        subscriptionInputTokens: 0,
        subscriptionOutputTokens: 0,
      },
    ]);
    mockBudgetsApi.overview.mockResolvedValue({
      companyId: COMPANY_ID,
      policies: [
        {
          policyId: "p1",
          companyId: COMPANY_ID,
          scopeType: "company",
          scopeId: COMPANY_ID,
          scopeName: "company-a",
          metric: "billed_cents",
          windowKind: "calendar_month_utc",
          amount: 220_000,
          observedAmount: 157_400,
          remainingAmount: 62_600,
          utilizationPercent: 71.5,
          warnPercent: 80,
          hardStopEnabled: false,
          notifyEnabled: true,
          isActive: true,
          status: "ok",
          paused: false,
          pauseReason: null,
          windowStart: "2026-09-01T00:00:00.000Z",
          windowEnd: "2026-10-01T00:00:00.000Z",
        },
      ],
      activeIncidents: [
        {
          id: "i1",
          companyId: COMPANY_ID,
          policyId: "p2",
          scopeType: "project",
          scopeId: "proj-1",
          scopeName: "project-a",
          metric: "billed_cents",
          windowKind: "calendar_month_utc",
          windowStart: "2026-09-01T00:00:00.000Z",
          windowEnd: "2026-10-01T00:00:00.000Z",
          thresholdType: "warn",
          amountLimit: 40_000,
          amountObserved: 48_200,
          status: "open",
          approvalId: null,
          approvalStatus: null,
          resolvedAt: null,
          createdAt: "2026-10-02T10:30:00.000Z",
          updatedAt: "2026-10-02T10:30:00.000Z",
        },
      ],
      pausedAgentCount: 0,
      pausedProjectCount: 1,
      pendingApprovalCount: 0,
    });
    mockBudgetsApi.resolveIncident.mockResolvedValue({});
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the spend tiles from the mocked costs summary", async () => {
    await renderScreen();

    expect(mockCostsApi.summary).toHaveBeenCalledWith(COMPANY_ID);
    const tileValues = [...container.querySelectorAll(".ui2-tile-value")].map(
      (tile) => tile.textContent,
    );
    // formatCents(157400) = $1,574.00 — the spend tile renders it verbatim.
    expect(tileValues.some((value) => value?.includes("1,574"))).toBe(true);
    // Utilization 71.5% rounds to 72%.
    expect(tileValues.some((value) => value?.includes("72%"))).toBe(true);
    // The incident tile counts 1 active incident from the overview.
    expect(tileValues.some((value) => value === "1")).toBe(true);
  });

  it("renders the per-agent table from the mocked by-agent data", async () => {
    await renderScreen();

    const rows = [...container.querySelectorAll(".ui2-costs-agents-row")];
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("agent-a");
  });

  it("exposes the legacy incident resolution actions with the vendor payloads", async () => {
    await renderScreen();

    const keepButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Keep paused",
    );
    const raiseButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Raise budget and resume",
    );
    expect(keepButton).toBeDefined();
    expect(raiseButton).toBeDefined();

    keepButton?.click();
    await flushReact();
    expect(mockBudgetsApi.resolveIncident).toHaveBeenCalledWith(COMPANY_ID, "i1", { action: "keep_paused" });

    raiseButton?.click();
    await flushReact();
    expect(mockBudgetsApi.resolveIncident).toHaveBeenCalledWith(COMPANY_ID, "i1", {
      action: "raise_budget_and_resume",
    });
  });

  it("renders budget policies from the overview", async () => {
    await renderScreen();
    const policy = container.querySelector(".ui2-policy-scope");
    expect(policy?.textContent).toContain("company-a");
  });
});
