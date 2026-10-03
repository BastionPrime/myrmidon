// @vitest-environment jsdom
// myrmidon(1.6-FORAGE): tests for the "Foraging" page. The API contract is the
// server module's (foraging/routes.ts); these tests mock the client.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Foraging } from "./Foraging";
import type { ForagingBudgetView, ForagingFinding, ForagingSource } from "@/api/foraging";

const sourcesMock = vi.hoisted(() => vi.fn());
const findingsMock = vi.hoisted(() => vi.fn());
const budgetMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const companyContextMock = vi.hoisted(() => ({ companyId: "company-1" as string | null }));

vi.mock("@/api/foraging", async () => {
  const actual = await vi.importActual<typeof import("@/api/foraging")>("@/api/foraging");
  return {
    ...actual,
    foragingApi: {
      sources: (...args: unknown[]) => sourcesMock(...args),
      findings: (...args: unknown[]) => findingsMock(...args),
      budget: (...args: unknown[]) => budgetMock(...args),
      saveSource: vi.fn(),
      removeSource: vi.fn(),
      sweep: vi.fn(),
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
  EmptyState: ({ message }: { message: string }) => <div data-testid="foraging-empty">{message}</div>,
}));

vi.mock("@/components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="foraging-skeleton">Loading…</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function source(overrides: Partial<ForagingSource> = {}): ForagingSource {
  return {
    id: "source-1",
    role: "engineer",
    url: "https://example.com/changelog",
    kind: "url",
    enabled: true,
    lastSnapshotAt: "2026-10-02T10:00:00.000Z",
    lastCheckedAt: "2026-10-02T10:00:00.000Z",
    lastError: null,
    snapshotLines: 12,
    ...overrides,
  };
}

function finding(overrides: Partial<ForagingFinding> = {}): ForagingFinding {
  return {
    id: "finding-1",
    sourceId: "source-1",
    role: "engineer",
    status: "unverified",
    summary: "foraged-engineer: 1 added",
    diff: { added: ["line-b"], removed: [] },
    skillKey: "foraged-engineer",
    candidateRef: null,
    reason: null,
    detectedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

const budget: ForagingBudgetView = {
  enabled: true,
  budget: { maxCostCents: 50, enabled: true },
  spentCents: 4,
  minHostIntervalMs: 60_000,
  intervalMs: 3_600_000,
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Foraging />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Renders and waits until `testId` is in the tree; queries settle on their own. */
async function renderAndSee(testId: string) {
  await render();
  await vi.waitFor(() => {
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
  });
}

function text() {
  return container.textContent ?? "";
}

beforeEach(() => {
  sourcesMock.mockResolvedValue({ sources: [source()], enabled: true });
  findingsMock.mockResolvedValue({ findings: [finding()], enabled: true });
  budgetMock.mockResolvedValue(budget);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  queryClient?.clear();
  vi.clearAllMocks();
});

describe("myrmidon(1.6-FORAGE) Foraging page", () => {
  it("lists the registry with the source role and url", async () => {
    await renderAndSee("foraging-sources-table");
    const rows = container.querySelectorAll('[data-testid="foraging-source-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("engineer");
    expect(rows[0].textContent).toContain("https://example.com/changelog");
  });

  it("shows the findings with their lifecycle state and diff size", async () => {
    await renderAndSee("foraging-findings-table");
    const rows = container.querySelectorAll('[data-testid="foraging-finding-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Unverified");
    expect(rows[0].textContent).toContain("foraged-engineer");
    expect(rows[0].textContent).toContain("+1");
  });

  it("shows a candidate reference once the lifecycle accepted a finding", async () => {
    findingsMock.mockResolvedValue({
      findings: [finding({ status: "candidate", candidateRef: "candidate-7" })],
      enabled: true,
    });
    await renderAndSee("foraging-findings-table");
    expect(container.querySelector('[data-testid="foraging-finding-row"]')?.textContent).toContain("candidate-7");
  });

  it("renders the pass budget", async () => {
    await renderAndSee("foraging-budget");
    const budgetRow = container.querySelector('[data-testid="foraging-budget"]');
    expect(budgetRow?.textContent).toContain("Pass budget");
    expect(budgetRow?.textContent).toContain("Spent this month");
  });

  it("explains that passes are off while the sweep is disabled", async () => {
    sourcesMock.mockResolvedValue({ sources: [], enabled: false });
    findingsMock.mockResolvedValue({ findings: [], enabled: false });
    await renderAndSee("foraging-disabled-note");
  });

  it("shows the empty state for the registry and the findings", async () => {
    sourcesMock.mockResolvedValue({ sources: [], enabled: true });
    findingsMock.mockResolvedValue({ findings: [], enabled: true });
    await renderAndSee("foraging-sources-empty");
    expect(container.querySelector('[data-testid="foraging-findings-empty"]')).not.toBeNull();
  });

  it("asks for an organization when none is selected", async () => {
    companyContextMock.companyId = null;
    await renderAndSee("foraging-empty");
    companyContextMock.companyId = "company-1";
  });

  it("shows a source error on its row", async () => {
    sourcesMock.mockResolvedValue({
      sources: [source({ lastError: "source answered 500" })],
      enabled: true,
    });
    await renderAndSee("foraging-source-row-error");
    expect(container.querySelector('[data-testid="foraging-source-row-error"]')?.textContent).toContain("500");
  });

  it("labels the page in the breadcrumbs", async () => {
    await renderAndSee("foraging-sources-table");
    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Foraging" }]);
  });
});