// ui/src/ui2/screens/settings/system/Ui2SystemSettings.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for Settings → System (channels, access,
// change log). Parity: members/keys/activity render from the mocked APIs;
// the change log is read-only this pass (no rollback buttons — vendor API
// has none); a 403 on members renders the denied lock with no data behind
// it (the operator's rule).

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2SystemSettings } from "./Ui2SystemSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listBoardApiKeys: vi.fn(),
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

const mockActivityApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/activity", () => ({
  activityApi: mockActivityApi,
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

describe("myrmidon(UI2) Ui2SystemSettings screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2SystemSettings />
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
    mockAccessApi.listMembers.mockResolvedValue({
      members: [
        {
          id: "m1",
          companyId: COMPANY_ID,
          principalType: "user",
          principalId: "u1",
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          user: { id: "u1", email: "owner@example.com", name: "Alex", image: null },
          grants: [],
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    mockAccessApi.listBoardApiKeys.mockResolvedValue([
      {
        id: "k1",
        name: "telegram-gateway-a",
        scope: { kind: "telegram_gateway" },
        createdAt: "2026-09-20T00:00:00.000Z",
        lastUsedAt: "2026-10-02T11:00:00.000Z",
        revokedAt: null,
        expiresAt: null,
      },
    ]);
    mockActivityApi.list.mockResolvedValue([
      {
        id: "a1",
        companyId: COMPANY_ID,
        actorType: "agent",
        actorId: "agent-1",
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        agentId: "agent-1",
        runId: null,
        responsibleUserId: null,
        details: null,
        createdAt: "2026-10-02T11:30:00.000Z",
      },
    ]);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders members, board api keys and the change log from the mocked APIs", async () => {
    await renderScreen();

    expect(mockAccessApi.listMembers).toHaveBeenCalledWith(COMPANY_ID);
    const memberRow = container.querySelector(".ui2-members-row");
    expect(memberRow?.textContent).toContain("Alex");
    expect(memberRow?.textContent).toContain("owner");

    const keyName = container.querySelector(".ui2-key-name");
    expect(keyName?.textContent).toBe("telegram-gateway-a");

    const changelogEntry = container.querySelector(".ui2-changelog-action");
    expect(changelogEntry?.textContent).toBe("agent.budget_updated");
  });

  it("renders the change log read-only: no rollback actions", async () => {
    await renderScreen();
    const rollback = [...container.querySelectorAll("button")].find((button) =>
      /rollback|undo|revert/i.test(button.textContent ?? ""),
    );
    expect(rollback).toBeUndefined();
  });

  it("shows the denied lock without partial numbers behind a 403", async () => {
    mockAccessApi.listMembers.mockRejectedValue(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    await renderScreen();

    const denied = container.querySelector('[data-testid="ui2-denied-state"]');
    expect(denied).not.toBeNull();
    // No member names, no counts — nothing behind the lock.
    expect(container.querySelector(".ui2-members-row")).toBeNull();
    expect(container.querySelector(".ui2-key-name")).toBeNull();
    expect(container.querySelector(".ui2-changelog-entry")).toBeNull();
  });
});
