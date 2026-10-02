// @vitest-environment jsdom
// myrmidon(SUC): tests for the "Stack" screen.
//
// The view is checked without a network against a fake registry document:
// every component renders, the unknown local state is reported honestly,
// lagging components sort first and a 503 stays on the page. The container
// test proves the "Schedule update" button creates a backlog draft task.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { StackScreen, StackScreenView } from "./StackScreen";
import { buildStackUpdatePlan, isLagging, sortStackComponents } from "./stackPresentation";
import type { StackDocument, StackSnapshot } from "./stackApi";

const mockStackApi = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
  check: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("./stackApi", () => ({
  stackApi: mockStackApi,
  stackQueryKey: ["myrmidon", "stack"],
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;
let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  globalThis.ResizeObserver = originalResizeObserver!;
  vi.clearAllMocks();
});

function byTestId(id: string) {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
}

function component(overrides: Partial<StackSnapshot> & Pick<StackSnapshot, "name">): StackSnapshot {
  return {
    version: 1,
    releaseSource: "github-releases",
    upstream: { kind: "github", repo: "example/repo" },
    localProbe: "docker-image",
    local: {
      version: null,
      commit: null,
      digest: null,
      runningOn: null,
      unknownReason: null,
      checkedAt: null,
      patches: [],
    },
    ...overrides,
  };
}

const DOCUMENT: StackDocument = {
  version: 2,
  refreshedAt: "2026-10-02T08:00:00.000Z",
  checkedAt: "2026-10-02T08:05:00.000Z",
  components: [
    component({
      name: "myrmidon",
      releaseSource: "github-tags",
      localProbe: "health-commit",
      local: {
        version: "1.4.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        digest: null,
        runningOn: "board server",
        unknownReason: null,
        checkedAt: "2026-10-02T08:00:00.000Z",
        patches: [],
      },
      upstreamState: {
        checkedAt: "2026-10-02T08:05:00.000Z",
        latest: "v1.4.0",
        latestPublishedAt: "2026-10-01T00:00:00.000Z",
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        previousLatest: "v1.4.0",
        behindBy: 0,
        notes: null,
        error: null,
      },
      patchClosed: { state: "closed", reason: "no carried deltas" },
    }),
    component({
      name: "hermes-agent",
      localProbe: "docker-image",
      local: {
        version: "v2026.9.24",
        commit: null,
        digest: "sha256:" + "a".repeat(64),
        runningOn: "agent host",
        unknownReason: null,
        checkedAt: "2026-10-02T08:00:00.000Z",
        patches: [
          {
            title: "gateway turn-body thread pool patch",
            private: true,
            ourVersion: "v2026.9.24",
            fixCommits: ["24758cf4b8"],
            state: "open",
            reason: "not in range",
          },
        ],
      },
      upstreamState: {
        checkedAt: "2026-10-02T08:05:00.000Z",
        latest: "v2026.10.1",
        latestPublishedAt: "2026-10-01T12:00:00.000Z",
        firstSeenAt: "2026-10-01T12:00:00.000Z",
        previousLatest: "v2026.9.24",
        behindBy: 3,
        notes: {
          lines: ["CVE-2026-1234 fixed in the gateway", "Breaking: config key renamed"],
          truncated: false,
          hasSecurity: true,
        },
        error: null,
      },
      patchClosed: { state: "open", reason: "our patch is not upstream yet" },
    }),
    component({
      name: "litellm",
      localProbe: "none",
      local: {
        version: null,
        commit: null,
        digest: null,
        runningOn: null,
        unknownReason: "not visible from the board",
        checkedAt: null,
        patches: [],
      },
    }),
  ],
};

function renderView(props: Partial<Parameters<typeof StackScreenView>[0]> = {}) {
  const merged = {
    doc: DOCUMENT,
    loading: false,
    error: null,
    pendingRefresh: false,
    pendingCheck: false,
    onRefresh: vi.fn(),
    onCheck: vi.fn(),
    onCreateDraft: vi.fn().mockResolvedValue("TASK-1"),
    ...props,
  };
  root = createRoot(container);
  flushSync(() => {
    root?.render(<StackScreenView {...merged} />);
  });
  return merged;
}

function renderContainer() {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <StackScreen />
      </QueryClientProvider>,
    );
  });
}

function setValue(element: HTMLElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: HTMLElement | null) {
  act(() => element!.click());
}

/** Flush pending promises (react-query resolution, async handlers) inside act. */
async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe("stackPresentation", () => {
  it("treats only a counted lag as lagging and sorts laggards first", () => {
    expect(isLagging(DOCUMENT.components[1]!)).toBe(true);
    expect(isLagging(DOCUMENT.components[0]!)).toBe(false);
    const ordered = sortStackComponents(DOCUMENT.components);
    expect(ordered.map((c) => c.name)).toEqual(["hermes-agent", "litellm", "myrmidon"]);
  });

  it("builds a plan with versions, patch state, notable lines and the rollback", () => {
    const plan = buildStackUpdatePlan(DOCUMENT.components[1]!);
    expect(plan).toContain("Upstream latest: v2026.10.1");
    expect(plan).toContain("Behind: 3 release(s)");
    expect(plan).toContain("CVE-2026-1234 fixed in the gateway");
    expect(plan).toContain("gateway turn-body thread pool patch: open");
    expect(plan).toContain("Canary");
    expect(plan).toContain("Rollback");
  });
});

describe("StackScreenView", () => {
  it("renders every component with our version and the upstream latest", () => {
    renderView();
    expect(byTestId("myrmidon-stack-table")).not.toBeNull();
    for (const name of ["myrmidon", "hermes-agent", "litellm"]) {
      expect(byTestId(`myrmidon-stack-row-${name}`)).not.toBeNull();
    }
    expect(byTestId("myrmidon-stack-ours-myrmidon")?.textContent).toContain("1.4.0");
    expect(byTestId("myrmidon-stack-latest-hermes-agent")?.textContent).toContain("v2026.10.1");
    expect(byTestId("myrmidon-stack-behind-hermes-agent")?.textContent).toContain("3");
    expect(byTestId("myrmidon-stack-patch-hermes-agent")?.textContent).toContain("open");
  });

  it("reports an unknown local state honestly, with the reason", () => {
    renderView();
    const cell = byTestId("myrmidon-stack-ours-litellm");
    expect(cell?.textContent).toContain("unknown");
    expect(cell?.textContent).toContain("not visible from the board");
  });

  it("lists lagging components above the rest", () => {
    renderView();
    const rows = Array.from(container.querySelectorAll('[data-testid^="myrmidon-stack-row-"]'));
    expect(rows[0]?.getAttribute("data-testid")).toBe("myrmidon-stack-row-hermes-agent");
  });

  it("offers the schedule button only on a lagging row", () => {
    renderView();
    expect(byTestId("myrmidon-stack-schedule-hermes-agent")).not.toBeNull();
    expect(byTestId("myrmidon-stack-schedule-myrmidon")).toBeNull();
  });

  it("keeps a 503 on the page instead of crashing", () => {
    renderView({ error: "stack check failed" });
    expect(byTestId("myrmidon-stack-error")?.textContent).toContain("stack check failed");
    expect(byTestId("myrmidon-stack-table")).not.toBeNull();
  });

  it("opens the dialog with the default plan and creates the draft", async () => {
    const props = renderView();
    click(byTestId("myrmidon-stack-schedule-hermes-agent"));
    expect(byTestId("myrmidon-stack-dialog")).not.toBeNull();
    expect(byTestId("myrmidon-stack-dialog-title")).toHaveProperty("value", "Update hermes-agent to v2026.10.1");
    const plan = (byTestId("myrmidon-stack-dialog-plan") as HTMLTextAreaElement).value;
    expect(plan).toContain("Canary");

    setValue(byTestId("myrmidon-stack-dialog-title")!, "Update hermes-agent now");
    click(byTestId("myrmidon-stack-dialog-create"));
    await flush();
    expect(props.onCreateDraft).toHaveBeenCalledTimes(1);
    expect(props.onCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Update hermes-agent now", description: expect.stringContaining("Canary") }),
    );
    expect(byTestId("myrmidon-stack-dialog-created")?.textContent).toContain("TASK-1");
  });
});

describe("StackScreen container", () => {
  it("creates an unassigned backlog draft task for a lagging component", async () => {
    mockStackApi.get.mockResolvedValue(DOCUMENT);
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1", identifier: "TASK-77" });
    renderContainer();
    await flush();
    expect(byTestId("myrmidon-stack-schedule-hermes-agent")).not.toBeNull();
    click(byTestId("myrmidon-stack-schedule-hermes-agent"));
    click(byTestId("myrmidon-stack-dialog-create"));
    await flush();
    expect(mockIssuesApi.create).toHaveBeenCalledTimes(1);
    const [companyId, payload] = mockIssuesApi.create.mock.calls[0] as [string, Record<string, unknown>];
    expect(companyId).toBe("company-1");
    expect(payload.status).toBe("backlog");
    expect(payload.title).toBe("Update hermes-agent to v2026.10.1");
    expect(String(payload.description)).toContain("Canary");
    expect(payload).not.toHaveProperty("assigneeAgentId");
    expect(payload).not.toHaveProperty("assigneeUserId");
    expect(byTestId("myrmidon-stack-dialog-created")?.textContent).toContain("TASK-77");
  });

  it("shows the 503 the release check returned", async () => {
    mockStackApi.get.mockResolvedValue(DOCUMENT);
    mockStackApi.check.mockRejectedValue(new ApiError("stack check failed", 503, { error: "stack check failed" }));
    renderContainer();
    await flush();
    expect(byTestId("myrmidon-stack-check")).not.toBeNull();
    click(byTestId("myrmidon-stack-check"));
    await flush();
    expect(byTestId("myrmidon-stack-error")?.textContent).toContain("stack check failed");
    expect(byTestId("myrmidon-stack-table")).not.toBeNull();
  });
});