// ui/src/ui2/screens/decisions/Ui2Decisions.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for the Decisions screen. Parity criteria
// from the ticket: the list renders from mocked API data; every legacy
// action stays reachable (decide with option + inputs + idempotency key,
// dismiss with reason); the same permission posture (board routes gate by
// session — no new surface). Red side: with the ui2 screen absent, these
// assertions fail (run on base in the PR proof).

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2Decisions } from "./Ui2Decisions";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";
import { queryKeys } from "@/lib/queryKeys";

const mockDecisionsApi = vi.hoisted(() => ({
  list: vi.fn(),
  decide: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@/api/decisions", () => ({
  decisionsApi: mockDecisionsApi,
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "company-a", issuePrefix: "OPE" },
  }),
}));

const NOW = new Date("2026-10-02T12:00:00.000Z").getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function decisionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    companyId: "company-1",
    bundleId: null,
    originAgentId: "agent-1",
    originIssueId: "issue-1",
    originRunId: "run-1",
    ruleKey: "budget_raise",
    title: "Raise the soft limit for the day",
    body: "The colony spends faster than planned. Choose how to continue.",
    options: [
      {
        id: "opt-raise",
        label: "Raise by $1",
        description: null,
        style: "primary",
        effects: [
          { type: "comment_on_issue", targetIssueId: "issue-1", staleness: "strict", bodyMarkdown: "raised" },
        ],
      },
      {
        id: "opt-keep",
        label: "Keep paused",
        description: null,
        effects: [
          { type: "update_issue_status", targetIssueId: "issue-1", staleness: "strict", status: "in_progress" },
        ],
      },
    ],
    inputs: [
      { id: "amount", label: "Amount", placeholder: "1.00", required: true, maxLength: 8 },
    ],
    status: "open",
    executionStatus: null,
    chosenOptionId: null,
    inputValues: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: minutesAgo(-120),
    idempotencyKey: null,
    targetSnapshots: {},
    continuationPolicy: "none",
    metadata: {},
    createdAt: minutesAgo(125),
    updatedAt: minutesAgo(125),
    targetChanged: {},
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2Decisions screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2Decisions />
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    mockDecisionsApi.list.mockResolvedValue([decisionFixture()]);
    mockDecisionsApi.decide.mockResolvedValue({});
    mockDecisionsApi.dismiss.mockResolvedValue({});
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", companyId: "company-1", name: "agent-a", status: "active" },
    ]);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders the decision list from the mocked decisions API", async () => {
    await renderScreen();

    expect(mockDecisionsApi.list).toHaveBeenCalledWith("company-1", { status: "open" });
    const title = container.querySelector(".ui2-decision-card-title");
    expect(title?.textContent).toBe("Raise the soft limit for the day");
    // The filter chips carry the group counts over the same data.
    const chips = [...container.querySelectorAll(".ui2-filter-chip")];
    expect(chips.length).toBe(4);
    expect(chips[0]?.textContent).toContain("1");
  });

  it("exposes the legacy decide action with option, inputs and idempotency key", async () => {
    await renderScreen();

    const amountInput = container.querySelector<HTMLInputElement>("#amount, input[maxlength='8']") ??
      [...container.querySelectorAll("input")].find((input) => input.value === "") ??
      null;
    expect(amountInput).not.toBeNull();
    await act(async () => {
      // Fill the required input first (typing via native setter keeps React state).
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(amountInput, "1.00");
      amountInput?.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await flushReact();

    const decideButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Decide",
    );
    expect(decideButtons.length).toBe(2);
    const disabled = decideButtons.every((button) => (button as HTMLButtonElement).disabled);
    expect(disabled).toBe(false);

    await act(async () => {
      decideButtons[0]?.click();
    });
    await flushReact();

    expect(mockDecisionsApi.decide).toHaveBeenCalledTimes(1);
    const call = mockDecisionsApi.decide.mock.calls[0];
    expect(call?.[0]).toBe("decision-1");
    const payload = call?.[1];
    expect(payload?.optionId).toBe("opt-raise");
    expect(payload?.inputValues).toEqual({ amount: "1.00" });
    expect(typeof payload?.idempotencyKey).toBe("string");
    expect(payload?.idempotencyKey?.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps the dismiss action reachable with a reason", async () => {
    await renderScreen();

    const dismissButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss",
    );
    expect(dismissButton).toBeDefined();
    const reasonInput = [...container.querySelectorAll("input")].find(
      (input) => input.getAttribute("aria-label") === "Dismiss",
    );
    expect(reasonInput).toBeDefined();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(reasonInput, "not now");
      reasonInput?.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      dismissButton?.click();
    });
    await flushReact();

    expect(mockDecisionsApi.dismiss).toHaveBeenCalledWith("decision-1", "not now");
  });

  it("re-renders through the same query cache key the vendor screen uses", async () => {
    await renderScreen();
    const cacheKey = queryKeys.decisions.list("company-1", "open");
    const cached = queryClient.getQueryData(cacheKey);
    expect(cached).toEqual([decisionFixture()]);
  });
});

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}
