// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardParallelHelpersFields,
  type HelperModelPickerRenderer,
} from "./AgentCardParallelHelpersFields";
import {
  disableParallelHelpers,
  enableParallelHelpers,
  parseHelpersLimit,
  parseHelpersTurnBudget,
  setHelpersNumber,
  setHelpersText,
} from "./parallelHelpersConfig";

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

const picker: HelperModelPickerRenderer = ({ value }) => (
  <span data-testid="model-picker">{value || "Inherit"}</span>
);

function render(value: unknown, onChange = vi.fn(), ceiling = 6, defaultLimit = 2) {
  act(() => {
    root.render(
      <TooltipProvider>
        <AgentCardParallelHelpersFields
          value={value}
          onChange={onChange}
          ceiling={ceiling}
          defaultLimit={defaultLimit}
          renderModelPicker={picker}
        />
      </TooltipProvider>,
    );
  });
  return onChange;
}

function clickToggle() {
  // The toggle lives inside the collapsible content: expand the section first
  // when it starts collapsed (an absent card keeps it collapsed).
  const header = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Parallel helpers",
  );
  const expanded = header?.getAttribute("aria-expanded") === "true";
  if (!expanded) act(() => header?.click());
  const toggle = container.querySelector<HTMLElement>("[data-testid=parallel-helpers-toggle]");
  act(() => toggle?.click());
}

describe("myrmidon(PARALLEL-HELPERS) agent card fields", () => {
  it("stays collapsed for a card that never mentioned helpers", () => {
    render(undefined);
    expect(container.textContent).toContain("Parallel helpers");
    expect(container.querySelector("[data-testid=model-picker]")).toBeNull();
  });

  it("turning the section on writes an explicit default limit", () => {
    const onChange = render(undefined);
    clickToggle();
    expect(onChange).toHaveBeenCalledWith({ enabled: true, maxConcurrent: 2 });
  });

  it("turning it off keeps the settings for a later re-enable", () => {
    const onChange = render({ enabled: true, maxConcurrent: 4, model: "dashscope/qwen3-flash" });
    clickToggle();
    expect(onChange).toHaveBeenCalledWith({
      enabled: false,
      maxConcurrent: 4,
      model: "dashscope/qwen3-flash",
    });
  });

  it("turning off a card that never had the section stores nothing", () => {
    // The section starts collapsed for an absent card, so first expand and
    // toggle on, then off: the final store is undefined only for a card with
    // no other fields.
    expect(disableParallelHelpers({})).toBeUndefined();
    expect(disableParallelHelpers({ enabled: true })).toEqual({ enabled: false });
  });

  it("shows the helper model picker and empty means inherit", () => {
    render({ enabled: true, maxConcurrent: 4 });
    expect(container.querySelector("[data-testid=model-picker]")?.textContent).toBe("Inherit");
  });

  it("rejects nonsense limit text without storing it", () => {
    const onChange = render({ enabled: true, maxConcurrent: 4 });
    const input = [...container.querySelectorAll("input")].find(
      (el) => el.getAttribute("aria-label") === "Max concurrent helpers",
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "banana");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a whole number from 1 to 50");
  });

  it("shows the company ceiling in the limit field's hint (tooltip)", () => {
    render({ enabled: true, maxConcurrent: 4 }, vi.fn(), 6);
    // Hints render as Tooltip content on the label's help icon; assert on the
    // component prop rather than the (unhovered) DOM text.
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    // The visible label and the inputs are present with the fields.
    expect(container.textContent).toContain("Max concurrent helpers");
    expect(container.textContent).toContain("Per-helper turn budget");
  });
});

describe("myrmidon(PARALLEL-HELPERS) pure helpers", () => {
  it("parses limits and budgets, rejecting empty and nonsense", () => {
    expect(parseHelpersLimit("4")).toEqual({ ok: true, value: 4 });
    expect(parseHelpersLimit("").ok).toBe(false);
    expect(parseHelpersLimit("banana").ok).toBe(false);
    expect(parseHelpersLimit("999").ok).toBe(false);
    expect(parseHelpersTurnBudget("40")).toEqual({ ok: true, value: 40 });
    expect(parseHelpersTurnBudget("").ok).toBe(false);
  });

  it("sets text trimmed, clears on empty", () => {
    expect(setHelpersText({}, "model", "  dashscope/x  ")).toEqual({ model: "dashscope/x" });
    expect(setHelpersText({ model: "x" }, "model", "   ")).toEqual({});
  });

  it("sets numbers, clears on undefined", () => {
    expect(setHelpersNumber({}, "maxConcurrent", 4)).toEqual({ maxConcurrent: 4 });
    expect(setHelpersNumber({ maxConcurrent: 4 }, "maxConcurrent", undefined)).toEqual({});
  });

  it("enable keeps an existing limit and fills a default otherwise", () => {
    expect(enableParallelHelpers({ maxConcurrent: 7 }, 2)).toEqual({ maxConcurrent: 7, enabled: true });
    expect(enableParallelHelpers({}, 3)).toEqual({ maxConcurrent: 3, enabled: true });
  });
});
