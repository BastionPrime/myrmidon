// ui/src/ui2/screens/agent-overview/Ui2AgentOverview.myrmidon.test.tsx — UI-2.0
//
// myrmidon(UI2): screen guard for the agent card's ui2 Overview route.
// The shell route table owns `agents/:agentId/overview`; this page loads
// the agent and runs through the EXISTING agent-card APIs and renders the
// overview surface. The guard pins: the run table, spend and agent budget
// render from the mocked APIs; the vendor AgentCard page is NOT edited.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2AgentOverview } from "./Ui2AgentOverview";
import { Ui2AgentOverviewPage } from "./Ui2AgentOverviewPage";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";

const mockCostsApi = vi.hoisted(() => ({
  byAgent: vi.fn(),
}));

vi.mock("@/api/costs", () => ({ costsApi: mockCostsApi }));

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
}));

vi.mock("@/api/budgets", () => ({ budgetsApi: mockBudgetsApi }));

const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));

const mockHeartbeatsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "company-a", issuePrefix: "OPE" },
  }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ agentId: "agent-1" }),
}));

const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

const agentFixture = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  name: "agent-a",
  status: "active",
  role: "engineer",
  adapterType: "claude_local",
};

const runsFixture = [
  {
    id: "run-1",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    invocationSource: "wakeup",
    triggerDetail: null,
    status: "succeeded",
    responsibleUserId: null,
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: {
      inputTokens: 120_000,
      outputTokens: 24_000,
      costUsd: 0.4321,
    },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    createdAt: new Date(Date.now() - 41 * 60_000).toISOString(),
  },
];

describe("myrmidon(UI2) Ui2AgentOverview screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen(node: React.ReactNode) {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">{node}</Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockCostsApi.byAgent.mockResolvedValue([
      {
        agentId: AGENT_ID,
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
          scopeType: "agent",
          scopeId: AGENT_ID,
          scopeName: "agent-a",
          metric: "billed_cents",
          windowKind: "calendar_month_utc",
          amount: 80_000,
          observedAmount: 62_310,
          remainingAmount: 17_690,
          utilizationPercent: 77.9,
          warnPercent: 70,
          hardStopEnabled: false,
          notifyEnabled: true,
          isActive: true,
          status: "warning",
          paused: false,
          pauseReason: null,
          windowStart: "2026-09-01T00:00:00.000Z",
          windowEnd: "2026-10-01T00:00:00.000Z",
        },
      ],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    });
    mockAgentsApi.get.mockResolvedValue(agentFixture);
    mockHeartbeatsApi.list.mockResolvedValue(runsFixture);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders the run table, spend and agent budget from the mocked APIs", async () => {
    await renderScreen(
      <Ui2AgentOverview agent={agentFixture as never} agentId={AGENT_ID} companyId={COMPANY_ID} runs={runsFixture as never} />,
    );

    expect(mockCostsApi.byAgent).toHaveBeenCalledWith(COMPANY_ID);
    expect(mockBudgetsApi.overview).toHaveBeenCalledWith(COMPANY_ID);

    const runRow = container.querySelector(".ui2-agent-runs-row");
    expect(runRow?.textContent).toContain("succeeded");

    const tileValues = [...container.querySelectorAll(".ui2-tile-value")].map((t) => t.textContent);
    // Spend 62310 cents → $623.10.
    expect(tileValues.some((value) => value?.includes("623"))).toBe(true);
    // Budget utilization 78% of $800.00.
    expect(tileValues.some((value) => value?.includes("800"))).toBe(true);
  });

  it("routed page loads the agent and runs through the existing agent-card APIs", async () => {
    await renderScreen(<Ui2AgentOverviewPage />);

    expect(mockAgentsApi.get).toHaveBeenCalledWith(AGENT_ID, COMPANY_ID);
    expect(mockHeartbeatsApi.list).toHaveBeenCalledWith(COMPANY_ID, AGENT_ID);
    expect(mockCostsApi.byAgent).toHaveBeenCalledWith(COMPANY_ID);

    const runRow = container.querySelector(".ui2-agent-runs-row");
    expect(runRow?.textContent).toContain("succeeded");
  });

  it("routed page renders the denied lock on a 403 with no data behind it", async () => {
    mockAgentsApi.get.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    await renderScreen(<Ui2AgentOverviewPage />);

    expect(container.querySelector('[data-testid="ui2-denied-state"]')).not.toBeNull();
    expect(container.querySelector(".ui2-agent-runs-row")).toBeNull();
    expect(mockCostsApi.byAgent).not.toHaveBeenCalled();
  });
});
