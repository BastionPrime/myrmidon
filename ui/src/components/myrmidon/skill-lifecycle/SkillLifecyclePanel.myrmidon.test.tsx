// @vitest-environment jsdom
// myrmidon(1.6-SKILL-LIFE): the skill lifecycle panel.
//
// The pure view and the label helpers: a verified skill shows who approved,
// a candidate shows its state, the history renders one line per event.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillLifecyclePanelView, type SkillLifecyclePanelViewProps } from "./SkillLifecyclePanel";
import {
  approverLabel,
  historyLine,
  revisionLabel,
  stateBadge,
  type SkillLifecycleEvent,
  type SkillLifecycleView,
} from "./lifecycleApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function skill(overrides: Partial<SkillLifecycleView> = {}): SkillLifecycleView {
  return {
    skillId: "skill-1",
    key: "example-skill",
    name: "Example skill",
    slug: "example-skill",
    state: "verified",
    implicit: false,
    currentVersionId: "version-2",
    verifiedVersionId: "version-2",
    previousVerifiedVersionId: "version-1",
    approvedBy: "user-b",
    approvedAt: "2026-10-02T09:00:00.000Z",
    reason: null,
    updatedAt: "2026-10-02T09:00:00.000Z",
    verifiedRevisionNumber: 2,
    ...overrides,
  };
}

function event(overrides: Partial<SkillLifecycleEvent> = {}): SkillLifecycleEvent {
  return {
    id: "event-1",
    skillId: "skill-1",
    fromState: "candidate",
    toState: "verified",
    versionId: "version-2",
    actorType: "user",
    actorId: "user-b",
    approvalId: "approval-1",
    reason: null,
    createdAt: "2026-10-02T09:00:00.000Z",
    ...overrides,
  };
}

function props(overrides: Partial<SkillLifecyclePanelViewProps> = {}): SkillLifecyclePanelViewProps {
  return {
    skills: [skill()],
    loading: false,
    error: null,
    selectedSkillId: null,
    history: [],
    historyLoading: false,
    busy: false,
    onSelect: vi.fn(),
    onRequestPromotion: vi.fn(),
    onDeprecate: vi.fn(),
    onRollback: vi.fn(),
    onSetCandidate: vi.fn(),
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

describe("lifecycle labels", () => {
  it("maps the states to badges", () => {
    expect(stateBadge("verified", false).label).toBe("verified");
    expect(stateBadge("candidate", false).label).toBe("candidate");
    expect(stateBadge("deprecated", false).label).toBe("deprecated");
    expect(stateBadge("verified", true).label).toBe("verified (unmanaged)");
  });

  it("labels the revision and the approver", () => {
    expect(revisionLabel(2)).toBe("revision 2");
    expect(revisionLabel(null)).toBe("—");
    expect(approverLabel(skill())).toContain("user-b");
    expect(approverLabel(skill({ approvedBy: null, implicit: true }))).toContain("unmanaged");
    expect(approverLabel(skill({ approvedBy: null, implicit: false }))).toBe("not approved");
  });

  it("renders a history line with the transition, the actor and the reason", () => {
    const line = historyLine(event({ reason: "approved by the board" }));
    expect(line).toContain("candidate → verified");
    expect(line).toContain("user-b");
    expect(line).toContain("approved by the board");
  });
});

describe("SkillLifecyclePanelView", () => {
  it("shows the state and who approved a verified skill", () => {
    render(<SkillLifecyclePanelView {...props()} />);
    expect(container.querySelector('[data-testid="myrmidon-skill-lifecycle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-skill-state-example-skill"]')?.textContent).toBe("verified");
    expect(container.textContent).toContain("user-b");
    expect(container.textContent).toContain("revision 2");
  });

  it("offers a rollback only when a previous verified revision exists", () => {
    const withPrevious = props();
    render(<SkillLifecyclePanelView {...withPrevious} />);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toContain("Roll back");

    act(() => root?.unmount());
    root = null;
    render(<SkillLifecyclePanelView {...props({ skills: [skill({ previousVerifiedVersionId: null })] })} />);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Roll back");
  });

  it("marks a candidate and hides the legacy badge", () => {
    render(<SkillLifecyclePanelView {...props({ skills: [skill({ state: "candidate", implicit: false })] })} />);
    expect(container.querySelector('[data-testid="myrmidon-skill-state-example-skill"]')?.textContent).toBe("candidate");
  });

  it("renders the history of the selected skill", () => {
    render(
      <SkillLifecyclePanelView
        {...props({ selectedSkillId: "skill-1", history: [event(), event({ id: "event-2", toState: "deprecated" })] })}
      />,
    );
    const history = container.querySelector('[data-testid="myrmidon-skill-lifecycle-history"]');
    expect(history).not.toBeNull();
    expect(history?.querySelectorAll("li")).toHaveLength(2);
  });

  it("surfaces an error and an empty list", () => {
    render(<SkillLifecyclePanelView {...props({ skills: [], error: "boom" })} />);
    expect(container.querySelector('[data-testid="myrmidon-skill-lifecycle-error"]')?.textContent).toContain("boom");

    act(() => root?.unmount());
    root = null;
    render(<SkillLifecyclePanelView {...props({ skills: [], error: null })} />);
    expect(container.querySelector('[data-testid="myrmidon-skill-lifecycle-empty"]')).not.toBeNull();
  });

  it("calls back when a row is selected and an action is pressed", () => {
    const onSelect = vi.fn();
    const onRequestPromotion = vi.fn();
    render(<SkillLifecyclePanelView {...props({ onSelect, onRequestPromotion })} />);
    act(() => {
      (container.querySelector('[data-testid="myrmidon-skill-row-example-skill"]') as HTMLButtonElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith("skill-1");
    const promote = [...container.querySelectorAll("button")].find((b) => b.textContent === "Request promotion");
    act(() => promote?.click());
    expect(onRequestPromotion).toHaveBeenCalled();
  });
});