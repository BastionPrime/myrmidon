// @vitest-environment jsdom

// myrmidon(EGRESS-B): the project's Egress section, rendered.
//
// The section's job in the acceptance criteria: a project can be switched from
// journaling to blocking, the switch is refused until the list is verified and
// non-empty, and a refused destination is visible here.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectEgressFieldsView, type ProjectEgressFieldsViewProps } from "./ProjectEgressFields";
import type { ProjectEgressView } from "./botEgressApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: ProjectEgressView = {
  projectId: "33333333-3333-4333-8333-333333333333",
  name: "example-project",
  mode: "log",
  effectiveMode: "log",
  verified: false,
  allow: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byId(id: string) {
  return container.querySelector(`[data-testid="myrmidon-project-egress-${id}"]`) as HTMLElement | null;
}

function renderView(overrides: Partial<ProjectEgressFieldsViewProps> = {}) {
  const onSave = vi.fn();
  const onMode = vi.fn();
  const onVerified = vi.fn();
  const props: ProjectEgressFieldsViewProps = {
    project: PROJECT,
    allowText: "",
    verified: false,
    mode: "log",
    saving: false,
    unsaved: true,
    error: null,
    refusals: [],
    refusalsError: null,
    onAllowText: vi.fn(),
    onVerified,
    onMode,
    onSave,
    ...overrides,
  };
  act(() =>
    root.render(
      <TooltipProvider>
        <ProjectEgressFieldsView {...props} />
      </TooltipProvider>,
    ),
  );
  return { onSave, onMode, onVerified };
}

describe("myrmidon(EGRESS-B) project egress section", () => {
  it("says the project is recording and offers the blocking switch", () => {
    renderView();
    expect(byId("blocking")).not.toBeNull();
    expect(byId("state")?.textContent).toMatch(/refuses nothing/);
    expect(byId("refusals")).toBeNull();
  });

  it("refuses to save a blocking mode whose list is not verified", () => {
    renderView({ mode: "block", verified: false, allowText: "api.example.com" });
    expect(byId("gate")?.textContent).toMatch(/Verified/);
    expect(byId("save")?.hasAttribute("disabled")).toBe(true);
  });

  it("refuses a list that is not destinations, before the save", () => {
    renderView({ allowText: "*.example.com" });
    expect(byId("problems")?.textContent).toMatch(/not a destination/);
    expect(byId("save")?.hasAttribute("disabled")).toBe(true);
  });

  it("allows the save once the list is verified and non-empty", () => {
    const { onSave } = renderView({ mode: "block", verified: true, allowText: "api.example.com" });
    expect(byId("gate")).toBeNull();
    const save = byId("save");
    expect(save?.hasAttribute("disabled")).toBe(false);
    act(() => save?.click());
    expect(onSave).toHaveBeenCalled();
  });

  it("shows the refusals of a blocking project", () => {
    renderView({ mode: "block", verified: true, refusals: ["agent-a → unknown.example.com:443"] });
    expect(byId("refusals")?.textContent).toContain("unknown.example.com:443");
  });

  it("says nothing has been refused yet, and reports an unreachable feed", () => {
    renderView({ mode: "block", verified: true });
    expect(byId("refusals-empty")?.textContent).toMatch(/Nothing has been refused/);
    renderView({ mode: "block", verified: true, refusalsError: "the request failed" });
    expect(byId("refusals-error")?.textContent).toMatch(/unavailable/);
  });

  it("warns when a saved blocking mode is not in force", () => {
    renderView({ project: { ...PROJECT, mode: "block", effectiveMode: "log" } });
    expect(byId("state")?.textContent).toMatch(/not in force/);
  });
});