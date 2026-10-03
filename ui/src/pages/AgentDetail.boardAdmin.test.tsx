// @vitest-environment jsdom
//
// myrmidon(ADMIN-AGENT): the Permissions tab of the agent card.
//
// Pins, per the acceptance points:
//   1. the "Board administrator" toggle shows the state from the agent detail
//      API and sends `boardAdmin` through updatePermissions (mocked);
//   2. an operator whose access summary carries no permission-management
//      authority (operator/viewer membership, not instance admin, not local
//      implicit) does not see the toggle at all;
//   3. a 403 from the PATCH surfaces a readable explanation under the toggle.

import { flushSync } from "react-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationTab } from "./AgentDetail";

const mockAgentsApi = vi.hoisted(() => ({
  update: vi.fn(),
  updatePermissions: vi.fn(),
  adapterModels: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn(async () => []) },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../lib/router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Ops Bot",
    urlKey: "opsbot",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canCreateSkills: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    chainOfCommand: [],
    access: {
      canAssignTasks: false,
      taskAssignSource: "none",
      membership: null,
      grants: [],
    },
    ...overrides,
  };
}

describe("myrmidon(ADMIN-AGENT) agent card permissions tab", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    Object.values(mockAgentsApi).forEach((mock) => mock.mockReset());
    mockAgentsApi.updatePermissions.mockResolvedValue({});
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  const noop = () => {};
  const mutate = vi.fn();

  function renderTab(agent: AgentDetail, operatorAccess: { source: string | null; isInstanceAdmin: boolean | null; membershipRole: string | null }) {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ConfigurationTab
              agent={agent}
              companyId="company-1"
              onDirtyChange={noop}
              onSaveActionChange={noop}
              onCancelActionChange={noop}
              onSavingChange={noop}
              updatePermissions={{ mutate, isPending: false }}
              operatorAccess={operatorAccess}
              content="permissions"
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  function boardAdminToggle() {
    return container.querySelector<HTMLElement>('[data-testid="board-admin-toggle"]');
  }

  it("shows the API state and sends boardAdmin through updatePermissions", async () => {
    const owner = { source: "session", isInstanceAdmin: false, membershipRole: "owner" };
    renderTab(
      makeAgent({
        access: {
          canAssignTasks: false,
          taskAssignSource: "none",
          membership: null,
          grants: [],
          boardAdmin: true,
        },
      }),
      owner,
    );
    await flushReact();

    expect(boardAdminToggle()?.getAttribute("aria-checked")).toBe("true");
    act(() => boardAdminToggle()?.click());
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ boardAdmin: false, canCreateAgents: false, canCreateSkills: true, canAssignTasks: false }),
      expect.anything(),
    );

    // Off-state from the permissions echo when the access summary lacks the field.
    renderTab(
      makeAgent({ permissions: { canCreateAgents: false, canCreateSkills: true, boardAdmin: true } }),
      owner,
    );
    await flushReact();
    expect(boardAdminToggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("hides the toggle for an operator without permission-management authority", async () => {
    for (const operatorAccess of [
      { source: "session", isInstanceAdmin: false, membershipRole: "operator" },
      { source: "session", isInstanceAdmin: false, membershipRole: "viewer" },
      { source: "session", isInstanceAdmin: false, membershipRole: null },
    ]) {
      renderTab(
        makeAgent({
          access: {
            canAssignTasks: false,
            taskAssignSource: "none",
            membership: null,
            grants: [],
            boardAdmin: true,
          },
        }),
        operatorAccess,
      );
      await flushReact();
      expect(boardAdminToggle()).toBeNull();
      expect(container.querySelector('[data-testid="board-admin-section"]')).toBeNull();
      if (root) await act(async () => { root?.unmount(); });
      root = null;
      const fresh = document.createElement("div");
      document.body.appendChild(fresh);
      container = fresh;
    }
  });

  it("shows a readable explanation when the PATCH answers 403", async () => {
    const owner = { source: "session", isInstanceAdmin: false, membershipRole: "owner" };
    renderTab(
      makeAgent({
        access: {
          canAssignTasks: false,
          taskAssignSource: "none",
          membership: null,
          grants: [],
          boardAdmin: false,
        },
      }),
      owner,
    );
    await flushReact();

    act(() => boardAdminToggle()?.click());
    // The parent passes an onError callback; simulate the 403 the API returns.
    const call = mutate.mock.calls.at(-1);
    const onError = call?.[1]?.onError as (error: unknown) => void;
    expect(onError).toBeTypeOf("function");
    act(() => {
      onError(new Error("Agents cannot change their own board administrator state"));
    });
    await flushReact();
    expect(container.querySelector('[data-testid="board-admin-error"]')?.textContent).toContain(
      "own board administrator state",
    );
  });
});
