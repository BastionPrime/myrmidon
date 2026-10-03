// @vitest-environment jsdom
//
// myrmidon(ADMIN-AGENT): the company rights page names the agent board
// administrators. The members table renders one row per agent whose
// `permissions.boardAdmin` is true, with a badge and a link to the agent's
// Permissions tab; agents without the flag get no row.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccess } from "./CompanyAccess";

const listMembersMock = vi.hoisted(() => vi.fn());
const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const updateMemberMock = vi.hoisted(() => vi.fn());
const archiveMemberMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listIssuesMock = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const listInvitesMock = vi.hoisted(() => vi.fn());
const mockSearchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
    listJoinRequests: (companyId: string, status: string) => listJoinRequestsMock(companyId, status),
    updateMember: (companyId: string, memberId: string, input: unknown) =>
      updateMemberMock(companyId, memberId, input),
    updateMemberPermissions: vi.fn(),
    updateMemberAccess: vi.fn(),
    archiveMember: (companyId: string, memberId: string, input: unknown) =>
      archiveMemberMock(companyId, memberId, input),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
    listInvites: (companyId: string, options: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: vi.fn(),
    revokeInvite: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters: unknown) => listIssuesMock(companyId, filters),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    mockNavigate(to, replace);
    return <div data-testid="navigate">{to}</div>;
  },
  useSearchParams: () => [
    mockSearchParamsState.current,
    (
      updater:
        | URLSearchParams
        | ((prev: URLSearchParams) => URLSearchParams),
    ) => {
      mockSearchParamsState.current =
        typeof updater === "function"
          ? updater(mockSearchParamsState.current)
          : new URLSearchParams(updater);
    },
  ],
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function agentRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: "company-1",
    name: `Agent ${id}`,
    urlKey: `agent${id}`,
    role: "engineer",
    status: "active",
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

describe("CompanyAccess board admin agents", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSearchParamsState.current = new URLSearchParams();
    listInvitesMock.mockResolvedValue({ invites: [], nextOffset: null });
    listMembersMock.mockResolvedValue({
      members: [
        {
          id: "member-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-1",
            email: "codexcoder@paperclip.local",
            name: "Codex Coder",
            image: null,
          },
          grants: [],
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: false,
      },
    });
    listJoinRequestsMock.mockResolvedValue([]);
    updateMemberMock.mockResolvedValue({});
    archiveMemberMock.mockResolvedValue({ reassignedIssueCount: 0 });
    listIssuesMock.mockResolvedValue([]);
    mockUsePluginSlots.mockReturnValue({ slots: [], isLoading: false, errorMessage: null });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lists agents flagged as board administrators with a badge and a permissions link", async () => {
    listAgentsMock.mockResolvedValue([
      agentRow("agent-1", { name: "Ops Bot", urlKey: "opsbot", permissions: { canCreateAgents: false, boardAdmin: true } }),
      agentRow("agent-2", { name: "Plain Bot", urlKey: "plainbot", permissions: { canCreateAgents: false } }),
      agentRow("agent-3", { name: "Board Bot", urlKey: "boardbot", permissions: { canCreateAgents: false, boardAdmin: true }, status: "paused" }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const rows = container.querySelectorAll('[data-testid="board-admin-agent-row"]');
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain("Ops Bot");
    expect(container.textContent).toContain("Board Bot");
    expect(container.textContent).not.toContain("Plain Bot");
    expect(
      Array.from(container.querySelectorAll('[data-testid="board-admin-agent-badge"]')).every(
        (badge) => badge.textContent === "Board administrator",
      ),
    ).toBe(true);
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="board-admin-agent-row"] a'));
    expect(links.some((link) => link.getAttribute("href") === "/agents/boardbot/permissions")).toBe(true);
    expect(links.some((link) => link.getAttribute("href") === "/agents/plainbot/permissions")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders no agent rows when no agent is a board administrator", async () => {
    listAgentsMock.mockResolvedValue([
      agentRow("agent-1", { name: "Plain Bot", urlKey: "plainbot" }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelectorAll('[data-testid="board-admin-agent-row"]').length).toBe(0);
    expect(container.textContent).not.toContain("Board administrator");

    await act(async () => {
      root.unmount();
    });
  });
});
