// @vitest-environment jsdom
// myrmidon(1.6 AUTONOMY-MATRIX B): container-tier tests for the autonomy
// screen — the wire tier against a mocked API client.
//
// Checked: the GET view renders; a cell click cycles the draft and Save
// PATCHes the whole matrix with expectedVersion; a regulation draft edit
// PATCHes the regulation; approve calls the approve verb; restore calls the
// revision restore verb; a 409 on save surfaces the version-conflict message.
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { AutonomyMatrixScreen } from "./AutonomyMatrixContainer";
import type { AutonomySnapshot as AutonomyView } from "@paperclipai/shared";

// Radix Select needs real pointer-event plumbing jsdom lacks; the plain-pass
// mock keeps the trigger a real button and the options as content.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SelectContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SelectItem: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  SelectTrigger: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) => createElement("span", null, placeholder),
}));

const autonomyApiMock = vi.hoisted(() => ({
  view: vi.fn(),
  updateMatrix: vi.fn(),
  createRegulation: vi.fn(),
  updateRegulation: vi.fn(),
  approveRegulation: vi.fn(),
  restoreRegulationRevision: vi.fn(),
}));

vi.mock("./autonomyApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./autonomyApi")>()),
  autonomyApi: autonomyApiMock,
  autonomyQueryKey: (companyId: string) => ["myrmidon", "autonomy", companyId],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;
let originalResizeObserver: typeof ResizeObserver | undefined;

const VIEW: AutonomyView = {
  matrix: {
    version: 3,
    rules: [{ role: "engineer", actionClass: "deploy", verdict: "forbidden" }],
    defaults: {
      merge: "approval_required",
      deploy: "allowed",
      spend_above_threshold: "approval_required",
      external_message: "approval_required",
      delete: "approval_required",
      pause_wake_agents: "approval_required",
      change_instructions: "forbidden",
      other: "approval_required",
    },
  },
  regulations: [
    {
      id: "reg-2",
      role: "cto",
      title: "Deploy draft",
      bodyMarkdown: "Draft body.",
      status: "draft",
      revision: 2,
      supersededBy: null,
      wikiPageId: null,
      createdAt: "2026-10-01T10:00:00.000Z",
      createdBy: { type: "board", id: "board-1" },
      updatedAt: "2026-10-02T12:00:00.000Z",
      updatedBy: { type: "board", id: "board-1" },
      revisions: [
        {
          revision: 1,
          title: "Deploy draft (r1)",
          bodyMarkdown: "Draft body.\n\n(r1 text)",
          status: "approved",
          author: { type: "board", id: "board-1" },
          at: "2026-10-01T10:00:00.000Z",
        },
        {
          revision: 2,
          title: "Deploy draft",
          bodyMarkdown: "Draft body.",
          status: "draft",
          author: { type: "board", id: "board-1" },
          at: "2026-10-02T12:00:00.000Z",
        },
      ],
    },
  ],
  changeLog: [],
};

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  autonomyApiMock.view.mockReset().mockResolvedValue(VIEW);
  autonomyApiMock.updateMatrix.mockReset().mockResolvedValue({ matrix: VIEW.matrix });
  autonomyApiMock.createRegulation.mockReset().mockResolvedValue(VIEW.regulations[0]);
  autonomyApiMock.updateRegulation.mockReset().mockResolvedValue(VIEW.regulations[0]);
  autonomyApiMock.approveRegulation.mockReset().mockResolvedValue(VIEW.regulations[0]);
  autonomyApiMock.restoreRegulationRevision.mockReset().mockResolvedValue(VIEW.regulations[0]);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  globalThis.ResizeObserver = originalResizeObserver!;
  vi.clearAllMocks();
});

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AutonomyMatrixScreen />
      </QueryClientProvider>,
    );
  });
  // react-query resolves the GET after a macrotask; settle before asserting.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function cell(role: string, actionClass: string): HTMLButtonElement {
  return container.querySelector(
    `[data-testid="myrmidon-autonomy-cell-${role}-${actionClass}"]`,
  ) as HTMLButtonElement;
}

/** Let react-query's async mutation callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("myrmidon(1.6) autonomy matrix container", () => {
  it("loads the view over the GET endpoint and renders it", async () => {
    await renderScreen();
    expect(autonomyApiMock.view).toHaveBeenCalledWith("company-1");
    expect(container.querySelector("[data-testid=myrmidon-autonomy-screen]")).not.toBeNull();
    // The container renders through the real i18n catalogs, so verdicts
    // appear as their English labels.
    expect(cell("engineer", "deploy").textContent).toContain("Forbidden");
  });

  it("cycles a cell into the draft and PATCHes the matrix with expectedVersion on save", async () => {
    await renderScreen();
    const save = container.querySelector(
      "[data-testid=myrmidon-autonomy-matrix-save]",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // forbidden → allowed → approval_required. The second step matters:
    // `allowed` IS this action's default, so the rule would drop out; after
    // the third click the verdict differs from the default and the rule is
    // carried in the patch.
    await act(async () => {
      cell("engineer", "deploy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cell("engineer", "deploy").textContent).toContain("Allowed");
    expect(save.disabled).toBe(false);
    await act(async () => {
      cell("engineer", "deploy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cell("engineer", "deploy").textContent).toContain("Approval");

    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(autonomyApiMock.updateMatrix).toHaveBeenCalledWith("company-1", {
      expectedVersion: 3,
      rules: [{ role: "engineer", actionClass: "deploy", verdict: "approval_required" }],
      defaults: VIEW.matrix.defaults,
    });
  });

  it("a cell at the default verdict removes the redundant rule from the patch", async () => {
    await renderScreen();
    // engineer/merge has no rule; the default is approval_required.
    // Cycle once: approval_required → forbidden (creates a rule).
    await act(async () => {
      cell("engineer", "merge").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cell("engineer", "merge").textContent).toContain("Forbidden");
    // Cycle twice more: forbidden → allowed → approval_required (back at the
    // default: the rule drops out).
    await act(async () => {
      cell("engineer", "merge").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      cell("engineer", "merge").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const save = container.querySelector(
      "[data-testid=myrmidon-autonomy-matrix-save]",
    ) as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(autonomyApiMock.updateMatrix).toHaveBeenCalledWith("company-1", {
      expectedVersion: 3,
      rules: [{ role: "engineer", actionClass: "deploy", verdict: "forbidden" }],
      defaults: VIEW.matrix.defaults,
    });
  });

  it("a 409 on save surfaces the version-conflict message", async () => {
    autonomyApiMock.updateMatrix.mockRejectedValueOnce(
      new ApiError("version mismatch", 409, { error: "version mismatch" }),
    );
    await renderScreen();
    await act(async () => {
      cell("engineer", "deploy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector("[data-testid=myrmidon-autonomy-matrix-save]") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
    const error = container.querySelector("[data-testid=myrmidon-autonomy-matrix-error]");
    expect(error).not.toBeNull();
    // The version-conflict copy names the server-side change, not the raw error.
    expect(error?.textContent).toContain("changed on the server");
  });

  it("editing a regulation draft PATCHes the regulation with the new text", async () => {
    await renderScreen();
    await act(async () => {
      (container.querySelector(
        "[data-testid=myrmidon-autonomy-regulation-toggle-reg-2]",
      ) as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const title = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-title-reg-2]",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(title, "Deploy draft, updated");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector(
        "[data-testid=myrmidon-autonomy-regulation-save-reg-2]",
      ) as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(autonomyApiMock.updateRegulation).toHaveBeenCalledWith("company-1", "reg-2", {
      title: "Deploy draft, updated",
      bodyMarkdown: "Draft body.",
    });
  });

  it("approve calls the approve verb for the draft regulation", async () => {
    await renderScreen();
    await act(async () => {
      (container.querySelector(
        "[data-testid=myrmidon-autonomy-regulation-approve-reg-2]",
      ) as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(autonomyApiMock.approveRegulation).toHaveBeenCalledWith("company-1", "reg-2");
  });

  it("restore calls the revision restore verb with the prior revision", async () => {
    await renderScreen();
    await act(async () => {
      (container.querySelector(
        "[data-testid=myrmidon-autonomy-regulation-restore-reg-2]",
      ) as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(autonomyApiMock.restoreRegulationRevision).toHaveBeenCalledWith("company-1", "reg-2", 1);
  });

  it("a load error is surfaced in place", async () => {
    autonomyApiMock.view.mockRejectedValueOnce(new ApiError("Request failed: 500", 500, {}));
    await renderScreen();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-error]")).not.toBeNull();
  });
});
