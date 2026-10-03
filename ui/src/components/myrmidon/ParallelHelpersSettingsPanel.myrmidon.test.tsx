// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ParallelHelpersSettingsPanelView,
  parseParallelHelpersDraft,
} from "./ParallelHelpersSettingsPanel";
import type { ParallelHelpersView } from "./parallelHelpersApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

const VIEW: ParallelHelpersView = {
  settings: {},
  effective: { ceiling: 10, defaultPerAgent: 2 },
  capacity: {
    requestedTotal: 4,
    enabledAgents: 2,
    buildSlots: null,
    exceedsBuildSlots: false,
    warning: null,
  },
};

function renderView(overrides: Partial<Parameters<typeof ParallelHelpersSettingsPanelView>[0]> = {}) {
  const onSave = vi.fn();
  const props = { view: VIEW, onSave, pending: false, error: null, ...overrides };
  act(() => {
    root.render(<ParallelHelpersSettingsPanelView {...props} />);
  });
  return { onSave, props };
}

function input(key: string) {
  return container.querySelector<HTMLInputElement>(`#parallel-helpers-${key}`)!;
}

function setText(key: string, value: string) {
  const el = input(key);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function save() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Save parallel helpers"),
  )!;
  act(() => button.click());
}

describe("myrmidon(PARALLEL-HELPERS) settings panel", () => {
  it("shows the effective ceiling and default from the view", () => {
    renderView();
    expect(container.querySelector("[data-testid=parallel-helpers-effective]")?.textContent).toContain(
      "ceiling 10, default 2 per agent",
    );
  });

  it("warns about host load for a ceiling above 50 instead of clamping (HELPERS-NO-CAP)", () => {
    renderView({
      view: { ...VIEW, settings: { maxPerAgent: 500 }, effective: { ceiling: 500, defaultPerAgent: 2 } },
    });
    const warning = container.querySelector("[data-testid=parallel-helpers-host-load-warning]");
    expect(warning?.textContent).toContain("500");
    expect(warning?.textContent).toContain("load on the host");
    // The value itself is shown as in force, not shrunk.
    expect(container.querySelector("[data-testid=parallel-helpers-effective]")?.textContent).toContain(
      "ceiling 500",
    );
  });

  it("shows the host-load warning for a high draft ceiling, and still saves it", () => {
    const { onSave } = renderView({ view: { ...VIEW, settings: { maxPerAgent: 5 } } });
    setText("maxPerAgent", "120");
    expect(
      container.querySelector("[data-testid=parallel-helpers-host-load-warning]")?.textContent,
    ).toContain("120");
    save();
    // A high value is the owner's decision: the warning never blocks the save.
    expect(onSave).toHaveBeenCalledWith({ maxPerAgent: 120 });
  });

  it("stays quiet for ceilings at or below the warn threshold", () => {
    renderView({ view: { ...VIEW, settings: { maxPerAgent: 50 }, effective: { ceiling: 50, defaultPerAgent: 2 } } });
    expect(container.querySelector("[data-testid=parallel-helpers-host-load-warning]")).toBeNull();
  });

  it("shows the capacity usage when there is no warning", () => {
    renderView();
    expect(container.querySelector("[data-testid=parallel-helpers-capacity-ok]")?.textContent).toContain(
      "4 slot(s) across 2 agent(s)",
    );
  });

  it("shows the capacity warning instead of a block when the total exceeds the slots", () => {
    renderView({
      view: {
        ...VIEW,
        capacity: {
          requestedTotal: 12,
          enabledAgents: 3,
          buildSlots: 6,
          exceedsBuildSlots: true,
          warning: "Helpers across 3 agent(s) can reach 12 at once, above the 6 shared build slot(s).",
        },
      },
    });
    expect(container.querySelector("[data-testid=parallel-helpers-capacity-warning]")?.textContent).toContain(
      "above the 6 shared build slot(s)",
    );
  });

  it("sends only the filled fields", () => {
    const { onSave } = renderView({ view: { ...VIEW, settings: { maxPerAgent: 5 } } });
    setText("defaultMaxPerAgent", "3");
    save();
    expect(onSave).toHaveBeenCalledWith({ defaultMaxPerAgent: 3, maxPerAgent: 5 });
  });

  it("rejects nonsense and does not save", () => {
    const { onSave } = renderView();
    setText("maxPerAgent", "banana");
    expect(container.querySelector("[data-testid=parallel-helpers-error-maxPerAgent]")?.textContent).toContain(
      "whole number",
    );
    save();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the save button disabled while pending", () => {
    renderView({ pending: true });
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Saving..."),
    )!;
    expect(button.disabled).toBe(true);
  });
});

describe("myrmidon(PARALLEL-HELPERS) parseParallelHelpersDraft", () => {
  const base = { maxPerAgent: "", defaultMaxPerAgent: "", buildSlots: "", hostMemoryMb: "" };
  it("empty means unset everywhere", () => {
    expect(parseParallelHelpersDraft(base)).toEqual({ patch: {}, errors: {} });
  });
  it("parses filled fields", () => {
    expect(parseParallelHelpersDraft({ ...base, maxPerAgent: "6", buildSlots: "8" })).toEqual({
      patch: { maxPerAgent: 6, buildSlots: 8 },
      errors: {},
    });
  });
  it("rejects zero, decimals and text", () => {
    const result = parseParallelHelpersDraft({ ...base, maxPerAgent: "0", buildSlots: "2.5" });
    expect(result.patch).toBeNull();
    expect(Object.keys(result.errors)).toEqual(["maxPerAgent", "buildSlots"]);
  });
});
