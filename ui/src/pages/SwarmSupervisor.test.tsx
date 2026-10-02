// @vitest-environment jsdom
// myrmidon(1.6-SWARM-CLAIM-B): tests for the "Swarm supervisor" page. The
// supervisor API contract is frozen in the design note (server part A); until
// part A merges these tests mock the contract's response shape.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SwarmSupervisor,
  claimHolderLabel,
  formatCountdown,
  formatDeltaPercent,
} from "./SwarmSupervisor";
import type {
  SwarmPilotReport,
  SwarmSupervisorClaim,
  SwarmSupervisorOverview,
  SwarmSupervisorRole,
} from "@/api/swarmSupervisor";

const overviewMock = vi.hoisted(() => vi.fn());
const releaseLeaseMock = vi.hoisted(() => vi.fn());
const pilotReportMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const companyContextMock = vi.hoisted(() => ({ companyId: "company-1" as string | null }));

vi.mock("@/api/swarmSupervisor", async () => {
  const actual = await vi.importActual<typeof import("@/api/swarmSupervisor")>("@/api/swarmSupervisor");
  return {
    ...actual,
    swarmSupervisorApi: {
      overview: (...args: unknown[]) => overviewMock(...args),
      releaseLease: (...args: unknown[]) => releaseLeaseMock(...args),
      pilotReport: (...args: unknown[]) => pilotReportMock(...args),
    },
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: companyContextMock.companyId }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ message, title, description }: { message: string; title?: string; description?: string }) => (
    <div data-testid="swarm-empty">
      {title ? <p>{title}</p> : null}
      <p>{message}</p>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));

vi.mock("@/components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="swarm-skeleton">Loading…</div>,
}));

vi.mock("@/components/PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span data-testid="swarm-priority">{priority}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function claim(overrides: Partial<SwarmSupervisorClaim> = {}): SwarmSupervisorClaim {
  return {
    claimId: "claim-1",
    issueId: "issue-1",
    identifier: "task-1",
    title: "task-one",
    priority: "high",
    agentId: "agent-a",
    agentName: "Agent A",
    claimedAt: "2026-09-30T10:00:00.000Z",
    expiresAt: "2026-09-30T11:00:00.000Z",
    heartbeatAt: "2026-09-30T10:30:00.000Z",
    expired: false,
    secondsToExpiry: 3725,
    ...overrides,
  };
}

function role(overrides: Partial<SwarmSupervisorRole> = {}): SwarmSupervisorRole {
  return {
    role: "engineer",
    queue: [
      {
        issueId: "issue-2",
        identifier: "task-2",
        title: "task-two",
        priority: "medium",
        projectId: "project-a",
        createdAt: "2026-09-29T09:00:00.000Z",
        blockedTransitionAt: null,
      },
    ],
    claims: [claim()],
    idleAgents: [
      { agentId: "agent-b", name: "Agent B", activeClaims: 0, atLimit: false },
      { agentId: "agent-c", name: "Agent C", activeClaims: 2, atLimit: true },
    ],
    ...overrides,
  };
}

function overview(overrides: Partial<SwarmSupervisorOverview> = {}): SwarmSupervisorOverview {
  return {
    enabled: true,
    generatedAt: "2026-10-02T12:05:00.000Z",
    leaseTtlSec: 900,
    maxActiveTasksPerAgent: 2,
    totals: {
      queued: 1,
      activeClaims: 1,
      expiredClaims: 0,
      agentsWithClaims: 1,
      idleAgentsWithQueue: 2,
    },
    roles: [role()],
    topQueue: [
      {
        issueId: "issue-2",
        identifier: "task-2",
        title: "task-two",
        priority: "medium",
        role: "engineer",
        projectId: "project-a",
        createdAt: "2026-09-29T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function pilotReport(overrides: Partial<SwarmPilotReport> = {}): SwarmPilotReport {
  return {
    window: { from: "2026-09-18T00:00:00.000Z", to: "2026-10-02T12:00:00.000Z" },
    enabled: true,
    generatedAt: "2026-10-02T12:05:00.000Z",
    pilot: null,
    baseline: null,
    comparison: {
      cycleTimeHoursMean: { pilot: 18, baseline: 20, deltaPercent: -10 },
      returnRate: { pilot: 0.2, baseline: 0.25, deltaPercent: -20 },
      timeInReviewHoursMean: { pilot: 4, baseline: 5, deltaPercent: -20 },
      costPerTaskMeanCents: { pilot: 100, baseline: 120, deltaPercent: -16.7 },
    },
    notes: ["Pilot window is shorter than the baseline window."],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(node: React.ReactNode) {
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pageRoot = createRoot(container);
  root = pageRoot;
  await act(async () => {
    pageRoot.render(
      <QueryClientProvider client={queryClient}>
        <SwarmSupervisor />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  return queryClient;
}

async function clickButton(label: string) {
  await act(async () => {
    const buttons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === label,
    );
    (buttons[0] as HTMLButtonElement).click();
  });
}

describe("formatters", () => {
  it("formats a remaining lease as a countdown and marks non-positive values expired", () => {
    expect(formatCountdown(3725)).toBe("1 h 2 m");
    expect(formatCountdown(125)).toBe("2 m 5 s");
    expect(formatCountdown(45)).toBe("45 s");
    expect(formatCountdown(0)).toBe("expired");
    expect(formatCountdown(-3)).toBe("expired");
  });

  it("falls back to the agent id when no name is present and signs deltas", () => {
    expect(claimHolderLabel(claim({ agentName: "" }))).toBe("agent-a");
    expect(claimHolderLabel(claim())).toBe("Agent A");
    expect(formatDeltaPercent(-10)).toBe("-10.0%");
    expect(formatDeltaPercent(4.5)).toBe("+4.5%");
    expect(formatDeltaPercent(null)).toBe("—");
  });
});

describe("SwarmSupervisor page", () => {
  it("renders the totals, the non-empty role's queue and lease rows, and the header values", async () => {
    overviewMock.mockResolvedValue(overview());
    await renderPage();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="swarm-role-engineer"]')).not.toBeNull();
    });

    const meta = container.querySelector('[data-testid="swarm-overview-meta"]')?.textContent ?? "";
    expect(meta).toContain("Lease TTL: 900 s");
    expect(meta).toContain("Max active tasks per agent: 2");

    expect(container.querySelector('[data-testid="swarm-totals"]')?.textContent).toContain("Queued tasks");

    // Queue row: identifier, title, priority and project.
    const queueTable = container.querySelector('[data-testid="swarm-queue-table-engineer"]');
    expect(queueTable?.textContent).toContain("task-2");
    expect(queueTable?.textContent).toContain("task-two");
    expect(queueTable?.textContent).toContain("medium");
    expect(queueTable?.textContent).toContain("project-a");

    // Lease row: holder name, countdown and the release action.
    const claimsTable = container.querySelector('[data-testid="swarm-claims-table-engineer"]');
    expect(claimsTable?.textContent).toContain("Agent A");
    expect(container.querySelector('[data-testid="swarm-claim-countdown-claim-1"]')?.textContent).toBe("1 h 2 m");
    expect(container.querySelector('[data-testid="swarm-release-claim-1"]')).not.toBeNull();

    // Idle agents: load against the cap and the at-limit flag.
    const idleTable = container.querySelector('[data-testid="swarm-idle-table-engineer"]');
    expect(idleTable?.textContent).toContain("Agent B");
    expect(idleTable?.textContent).toContain("0 / 2");
    expect(idleTable?.textContent).toContain("At limit");

    // The overview fetch used the selected company.
    expect(overviewMock).toHaveBeenCalledTimes(1);
    expect(overviewMock.mock.calls[0]?.[0]).toBe("company-1");
  });

  it("renders an expired lease as expired rather than a countdown", async () => {
    overviewMock.mockResolvedValue(
      overview({ roles: [role({ claims: [claim({ expired: true, secondsToExpiry: -5 })] })] }),
    );
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="swarm-claim-expired-claim-1"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="swarm-claim-countdown-claim-1"]')).toBeNull();
  });

  it("calls the release API with the claim id when the release button is clicked", async () => {
    overviewMock.mockResolvedValue(overview());
    releaseLeaseMock.mockResolvedValue({
      released: true,
      claimId: "claim-1",
      issueId: "issue-1",
      wokenAgentId: "agent-b",
      reason: "rebalanced",
    });
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="swarm-release-claim-1"]')).not.toBeNull();
    });

    await act(async () => {
      (container.querySelector('[data-testid="swarm-release-claim-1"]') as HTMLButtonElement).click();
    });

    await vi.waitFor(() => {
      expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
    });
    expect(releaseLeaseMock.mock.calls[0]).toEqual(["company-1", { claimId: "claim-1" }]);
  });

  it("shows the pilot-disabled empty state on a 503-style not-enabled error", async () => {
    overviewMock.mockResolvedValue(overview());
    pilotReportMock.mockRejectedValue(new Error("swarm pilot is not enabled"));
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="swarm-role-engineer"]')).not.toBeNull();
    });

    await clickButton("Pilot vs BASELINE");

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Swarm pilot is disabled");
    });
    expect(container.textContent).toContain("not enabled on this instance");
    expect(pilotReportMock.mock.calls[0]?.[0]).toBe("company-1");
  });

  it("shows the empty state when the overview has no roles, leases or queue", async () => {
    overviewMock.mockResolvedValue(
      overview({
        roles: [],
        topQueue: [],
        totals: { queued: 0, activeClaims: 0, expiredClaims: 0, agentsWithClaims: 0, idleAgentsWithQueue: 0 },
      }),
    );
    await renderPage();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("No roles to supervise");
    });
  });

  it("shows a plain error message for other failures", async () => {
    overviewMock.mockRejectedValue(new Error("Request failed: 500"));
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="swarm-error"]')?.textContent).toContain("Request failed: 500");
    });
  });

  it("shows the disabled empty state when the overview reports enabled:false", async () => {
    overviewMock.mockResolvedValue(overview({ enabled: false }));
    await renderPage();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Swarm supervisor is disabled");
    });
  });

  it("does not fetch and shows the company prompt without a company selection", async () => {
    companyContextMock.companyId = null;
    try {
      overviewMock.mockResolvedValue(overview());
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <SwarmSupervisor />
        </QueryClientProvider>,
      );
      expect(container.textContent).toContain("Select an organization to view swarm role queues.");
      expect(overviewMock).not.toHaveBeenCalled();
    } finally {
      companyContextMock.companyId = "company-1";
    }
  });
});