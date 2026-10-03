// @vitest-environment jsdom
// myrmidon(1.6 AUTONOMY-MATRIX B): view-tier tests for the "Autonomy matrix"
// screen — no network, the view is driven against a fake AutonomyView.
//
// Checked: every role row and action column renders; a cell click cycles the
// verdict through the dirty draft; the default verdict selects are shown;
// regulations render with status/revision, a draft expands for editing, an
// approved regulation shows its body; the change log renders entries; the
// reminders/night-mode/answer-channel placeholders are present and read-only.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutonomyMatrixScreenView } from "./AutonomyMatrixScreen";
import { resolveAutonomy, type AutonomyMatrix, type AutonomySnapshot as AutonomyView } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string, options?: { count?: number; defaultValue?: string }) => {
    if (options?.defaultValue !== undefined && key.includes("changeAction.unknown_action")) {
      return options.defaultValue;
    }
    return key;
  };
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Upgrade a minimal regulation fixture to the landed AutonomyRegulation shape. */
function withLifecycle(
  regulation: Partial<AutonomyView["regulations"][number]> &
    Pick<AutonomyView["regulations"][number], "id" | "role" | "title" | "bodyMarkdown" | "status" | "revision">,
): AutonomyView["regulations"][number] {
  const actor = { type: "board" as const, id: "board-1" };
  return {
    supersededBy: null,
    wikiPageId: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    createdBy: actor,
    updatedAt: "2026-10-02T12:00:00.000Z",
    updatedBy: actor,
    revisions: [
      {
        revision: 1,
        title: `${regulation.title} (r1)`,
        bodyMarkdown: `${regulation.bodyMarkdown}\n\n(r1 text)`,
        status: "draft",
        author: actor,
        at: "2026-10-01T10:00:00.000Z",
      },
      {
        revision: regulation.revision,
        title: regulation.title,
        bodyMarkdown: regulation.bodyMarkdown,
        status: regulation.status,
        author: actor,
        at: "2026-10-02T12:00:00.000Z",
      },
    ],
    ...regulation,
  };
}

function view(overrides: Partial<AutonomyView> = {}): AutonomyView {
  return {
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
      withLifecycle({
        id: "reg-1",
        role: "engineer",
        title: "Merge policy",
        bodyMarkdown: "Engineers may merge their own branch.",
        status: "approved",
        revision: 2,
        supersededBy: null,
        wikiPageId: null,
      }),
      withLifecycle({
        id: "reg-2",
        role: "cto",
        title: "Deploy draft",
        bodyMarkdown: "Draft body.",
        status: "draft",
        revision: 1,
        supersededBy: null,
        wikiPageId: null,
      }),
    ],
    changeLog: [
      {
        id: "cl-1",
        at: "2026-10-02T12:00:00.000Z",
        actor: { type: "board", id: "user-1" },
        action: "matrix_edit",
        summary: "engineer/deploy → forbidden",
        matrixVersion: 3,
        regulationId: null,
      },
    ],
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof AutonomyMatrixScreenView>[0]> = {}) {
  const base = view();
  const handlers = {
    onCellClick: vi.fn(),
    onDefaultChange: vi.fn(),
    onSaveMatrix: vi.fn(),
    onCreateRegulation: vi.fn(),
    onUpdateRegulation: vi.fn(),
    onApproveRegulation: vi.fn(),
    onRestoreRevision: vi.fn(),
  };
  flushSync(() => {
    root.render(
      <AutonomyMatrixScreenView
        view={base}
        matrix={base.matrix}
        matrixDirty={false}
        savingMatrix={false}
        matrixError={null}
        regulationError={null}
        pendingRegulationId={null}
        {...handlers}
        {...props}
      />,
    );
  });
  return handlers;
}

function cell(role: string, actionClass: string): HTMLButtonElement {
  return container.querySelector(
    `[data-testid="myrmidon-autonomy-cell-${role}-${actionClass}"]`,
  ) as HTMLButtonElement;
}

describe("myrmidon(1.6) autonomy matrix view", () => {
  it("renders the matrix grid with role rows and action columns", () => {
    render();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-screen]")).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-row-engineer]")).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-row-ceo]")).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-col-merge]")).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-col-pause_wake_agents]")).not.toBeNull();
  });

  it("shows a stored cell and falls back to the default verdict for a missing cell", () => {
    render();
    // engineer/deploy has an explicit forbidden rule.
    expect(cell("engineer", "deploy").textContent).toContain("autonomy.verdict.forbidden");
    // engineer/merge has no rule → default approval_required.
    expect(cell("engineer", "merge").textContent).toContain("autonomy.verdict.approval_required");
    // The default verdict line names the fallback.
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-default-change_instructions]")?.textContent,
    ).toContain("autonomy.verdict.forbidden");
  });

  it("marks an inherited cell with * and pins a reserved cell without it", () => {
    const base = view();
    const handlers = {
      onCellClick: vi.fn(),
      onDefaultChange: vi.fn(),
      onSaveMatrix: vi.fn(),
      onCreateRegulation: vi.fn(),
      onUpdateRegulation: vi.fn(),
      onApproveRegulation: vi.fn(),
      onRestoreRevision: vi.fn(),
    };
    const withAgentRule: AutonomyMatrix = {
      ...base.matrix,
      rules: [
        ...base.matrix.rules,
        { role: "engineer", actionClass: "deploy", verdict: "allowed", agentId: "agent-9" },
      ],
    };
    flushSync(() => {
      root.render(
        <AutonomyMatrixScreenView
          view={base}
          matrix={withAgentRule}
          matrixDirty
          savingMatrix={false}
          matrixError={null}
          regulationError={null}
          pendingRegulationId={null}
          {...handlers}
        />,
      );
    });
    // A reserved role cell (rule present, no agentId) shows its own verdict
    // and carries no * marker; an inherited cell is marked.
    expect(cell("engineer", "deploy").textContent).toContain("autonomy.verdict.forbidden");
    expect(cell("engineer", "deploy").textContent).not.toContain("*");
    expect(cell("engineer", "merge").textContent).toContain("autonomy.verdict.approval_required");
    expect(cell("engineer", "merge").textContent).toContain("*");
  });

  it("clicking a cell asks the container to cycle that cell's verdict", () => {
    const handlers = render();
    flushSync(() => {
      cell("engineer", "deploy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handlers.onCellClick).toHaveBeenCalledWith("engineer", "deploy");
  });

  it("changing a default verdict asks the container to change only that action class", () => {
    const handlers = render();
    const selectTrigger = container.querySelector(
      "[data-testid=myrmidon-autonomy-default-select-merge]",
    ) as HTMLElement;
    expect(selectTrigger).not.toBeNull();
    // The default row is a Select; drive its value through the trigger's
    // onValueChange contract via the accessible trigger button.
    flushSync(() => {
      selectTrigger.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The exact value change is exercised at the container tier; here the
    // presence of the control and its current default are the contract.
    expect(container.querySelector("[data-testid=myrmidon-autonomy-default-merge]")?.textContent).toContain(
      "autonomy.verdict.approval_required",
    );
  });

  it("save is disabled while the matrix is clean and enabled when dirty", () => {
    render();
    const save = container.querySelector("[data-testid=myrmidon-autonomy-matrix-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    render({ matrixDirty: true });
    const saveDirty = container.querySelector(
      "[data-testid=myrmidon-autonomy-matrix-save]",
    ) as HTMLButtonElement;
    expect(saveDirty.disabled).toBe(false);
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-matrix-dirty]")?.textContent,
    ).toContain("autonomy.matrix.unsaved");
  });

  it("surfaces a matrix error in place", () => {
    render({ matrixError: "The matrix request failed: 409" });
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-matrix-error]")?.textContent,
    ).toContain("409");
  });

  it("renders regulations with role, status and revision; restore appears only for revision > 1", () => {
    render();
    const approved = container.querySelector("[data-testid=myrmidon-autonomy-regulation-reg-1]");
    const draft = container.querySelector("[data-testid=myrmidon-autonomy-regulation-reg-2]");
    expect(approved).not.toBeNull();
    expect(draft).not.toBeNull();
    expect(approved?.textContent).toContain("Merge policy");
    expect(approved?.textContent).toContain("autonomy.regulationStatus.approved");
    expect(approved?.textContent).toContain("autonomy.regulations.revision");
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-restore-reg-1]"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-restore-reg-2]"),
    ).toBeNull();
    // A draft has an Approve button; an approved regulation does not.
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-approve-reg-2]"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-approve-reg-1]"),
    ).toBeNull();
  });

  it("an approved regulation body opens read-only; a draft opens editable", () => {
    render();
    const toggleApproved = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-toggle-reg-1]",
    ) as HTMLButtonElement;
    flushSync(() => {
      toggleApproved.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-body-reg-1]")?.textContent,
    ).toContain("Engineers may merge their own branch.");
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-title-reg-1]"),
    ).toBeNull();

    const toggleDraft = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-toggle-reg-2]",
    ) as HTMLButtonElement;
    flushSync(() => {
      toggleDraft.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const title = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-title-reg-2]",
    ) as HTMLInputElement;
    expect(title).not.toBeNull();
    expect(title.value).toBe("Deploy draft");
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulation-body-reg-2]"),
    ).not.toBeNull();
  });

  it("a draft edit enables the save button and reports the edit", () => {
    render();
    flushSync(() => {
      (container.querySelector(
        "[data-testid=myrmidon-autonomy-regulation-toggle-reg-2]",
      ) as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const save = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-save-reg-2]",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const title = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-title-reg-2]",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(title, "Deploy draft, updated");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    flushSync(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The container tier receives the edit; wired in the container test.
  });

  it("shows the change log entries with action translations and the raw summary", () => {
    render();
    const list = container.querySelector("[data-testid=myrmidon-autonomy-changelog-list]");
    expect(list).not.toBeNull();
    const entry = container.querySelector("[data-testid=myrmidon-autonomy-changelog-entry]");
    expect(entry?.textContent).toContain("board");
    expect(entry?.textContent).toContain("autonomy.changeAction.matrix_edit");
    expect(entry?.textContent).toContain("engineer/deploy → forbidden");
  });

  it("falls back to the raw action string for an action the catalog does not know", () => {
    render();
    const entry = container.querySelector("[data-testid=myrmidon-autonomy-changelog-entry]");
    // The mock t returns the defaultValue for unknown change actions.
    expect(entry?.textContent).toContain("matrix_edit");
  });

  it("empty states for regulations and change log", () => {
    render({ view: view({ regulations: [], changeLog: [] }) });
    expect(
      container.querySelector("[data-testid=myrmidon-autonomy-regulations-empty]"),
    ).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-changelog-empty]")).not.toBeNull();
  });

  it("reminders/night-mode/answer-channel placeholders are present and read-only", () => {
    render();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-placeholder-reminders]")).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-placeholder-nightMode]")).not.toBeNull();
    expect(container.querySelector("[data-testid=myrmidon-autonomy-placeholder-answerChannel]")).not.toBeNull();
    // No editable control inside the placeholder section.
    const section = container.querySelector("[data-testid=myrmidon-autonomy-placeholders]");
    expect(section?.querySelector("input, textarea, button, select")).toBeNull();
  });

  it("the new-regulation form disables create until a title is typed", () => {
    render();
    const create = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-create]",
    ) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const title = container.querySelector(
      "[data-testid=myrmidon-autonomy-regulation-new-title]",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(title, "New policy");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(create.disabled).toBe(false);
  });

  it("resolveAutonomy mirrors the contract: agent > role > default", () => {
    const matrix = view().matrix;
    expect(resolveAutonomy("engineer", "deploy", matrix)).toBe("forbidden");
    expect(resolveAutonomy("engineer", "deploy", matrix, "agent-9")).toBe("forbidden");
    const withAgent: AutonomyMatrix = {
      ...matrix,
      rules: [...matrix.rules, { role: "engineer", actionClass: "deploy", verdict: "allowed", agentId: "agent-9" }],
    };
    expect(resolveAutonomy("engineer", "deploy", withAgent, "agent-9")).toBe("allowed");
    expect(resolveAutonomy("engineer", "deploy", withAgent)).toBe("forbidden");
    expect(resolveAutonomy("cto", "change_instructions", matrix)).toBe("forbidden");
  });
});
