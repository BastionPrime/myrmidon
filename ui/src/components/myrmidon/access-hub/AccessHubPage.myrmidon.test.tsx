// @vitest-environment jsdom
//
// The access hub screen shipped before its server API. On an instance that
// answers 404 (no route) or 501 (route without a handler) the screen must show
// the not-available notice instead of an empty table over a failed request,
// and it must not treat that answer as an error.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { AccessHubPage } from "./AccessHubPage";
import type { AccessRecord } from "./accessHubApi";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => {
  class MockApiError extends Error {
    status: number;
    body: unknown;

    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  }
  return { api: apiMock, ApiError: MockApiError };
});

vi.mock("@/api/agents", () => ({
  agentsApi: { list: () => Promise.resolve([]) },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-a", selectedCompany: null }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }),
}));

// PageTabBar reads the sidebar context (jsdom has no real sidebar).
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: () => undefined }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The copy the notice is specified with (en locale). */
const NOTICE_TITLE = "Access hub is not available on this server yet";

function accessRecord(): AccessRecord {
  return {
    secretId: "secret-a",
    name: "Deploy key",
    key: "DEPLOY_KEY",
    kind: "ssh_key",
    status: "active",
    latestVersion: 3,
    createdAt: "2026-09-20T10:00:00.000Z",
    lastRotatedAt: "2026-09-25T08:30:00.000Z",
    bindings: [],
    hostRefs: [],
    fingerprint: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  pushToast.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

async function renderPage() {
  const queryClient = new QueryClient({
    // `retryDelay: 0` keeps the retry budget of a real failure inside the test;
    // `retry` itself comes from the query (see accessHubQueryRetry).
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <AccessHubPage />
      </QueryClientProvider>,
    ),
  );
  await flush();
}

describe("AccessHubPage without the access-hub server API", () => {
  it.each([404, 501])("shows the not-available notice on a %i answer", async (status) => {
    apiMock.get.mockImplementation(() =>
      Promise.reject(new ApiError(`Request failed: ${status}`, status, null)),
    );

    await renderPage();

    const notice = container.querySelector('[data-testid="access-hub-unavailable"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(NOTICE_TITLE);
    // No table and no empty state pretending to be real data, no error styling.
    expect(container.querySelector('[data-testid="access-hub-list"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pushToast).not.toHaveBeenCalled();
    // One probe for the whole screen: no retries and no other access-hub route.
    expect(apiMock.get).toHaveBeenCalledTimes(1);
    expect(apiMock.get).toHaveBeenCalledWith("/myrmidon/access-hub/accesses");
  });
});

describe("AccessHubPage with the access-hub server API", () => {
  it("keeps the access list and shows no notice", async () => {
    apiMock.get.mockImplementation((path: string) => {
      if (path === "/myrmidon/access-hub/accesses") return Promise.resolve([accessRecord()]);
      return Promise.resolve([]);
    });

    await renderPage();

    expect(container.querySelector('[data-testid="access-hub-unavailable"]')).toBeNull();
    expect(container.querySelector('[data-testid="access-hub-list"]')).not.toBeNull();
    expect(container.textContent).toContain("Deploy key");
    expect(container.textContent).toContain("Accesses");
    expect(container.textContent).toContain("Journal");
  });

  it("keeps a real failure an error, not a not-available state", async () => {
    apiMock.get.mockImplementation(() => Promise.reject(new ApiError("Boom", 500, null)));

    await renderPage();

    expect(container.querySelector('[data-testid="access-hub-unavailable"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    // The retry budget still applies to a real failure: 1 try + 3 retries.
    expect(apiMock.get).toHaveBeenCalledTimes(4);
  });
});