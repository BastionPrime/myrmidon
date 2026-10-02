// @vitest-environment jsdom
//
// myrmidon(C0) RUNTIME-LIMITS: the Run limits section of Instance → General.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLimitKey, RunLimitsSource } from "@paperclipai/shared";
import type { RuntimeLimitsView } from "./runtimeLimitsApi";
import { RuntimeLimitsSettingsPanelView, parseRunLimitsDraft } from "./RuntimeLimitsSettingsPanel";

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
  flushSync(() => root.unmount());
  container.remove();
});

const view: RuntimeLimitsView = {
  limits: { maxConcurrentRuns: 6, maxStartsPerMinute: null, minFreeMemoryMb: 2048, runMemoryEstimateMb: 300 },
  sources: {
    maxConcurrentRuns: "env",
    maxStartsPerMinute: "default",
    minFreeMemoryMb: "env",
    runMemoryEstimateMb: "default",
  } as Record<RunLimitKey, RunLimitsSource>,
};

function render(value: RuntimeLimitsView | null, onSave = vi.fn(), pending = false, error: string | null = null) {
  flushSync(() => {
    root.render(<RuntimeLimitsSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />);
  });
  return onSave;
}

function field(key: RunLimitKey): HTMLInputElement {
  return container.querySelector(`#runtime-limit-${key}`) as HTMLInputElement;
}

function type(key: RunLimitKey, text: string) {
  const input = field(key);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save run limits"))!;
}

describe("myrmidon(C0) run limits panel", () => {
  it("shows the effective values with where each one came from", () => {
    render(view);
    expect(field("maxConcurrentRuns").value).toBe("6");
    // An unset cap is an empty field: the limit is off.
    expect(field("maxStartsPerMinute").value).toBe("");
    expect(field("minFreeMemoryMb").value).toBe("2048");
    expect(field("runMemoryEstimateMb").value).toBe("300");
    expect(container.querySelector("[data-testid=runtime-limit-source-maxConcurrentRuns]")?.textContent).toBe(
      "From the server environment",
    );
    expect(container.querySelector("[data-testid=runtime-limit-source-maxStartsPerMinute]")?.textContent).toBe(
      "Default",
    );
  });

  it("saves all four values, an empty field as 'no limit'", () => {
    const onSave = render(view);
    type("maxConcurrentRuns", "12");
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith({
      maxConcurrentRuns: 12,
      maxStartsPerMinute: null,
      minFreeMemoryMb: 2048,
      runMemoryEstimateMb: 300,
    });
  });

  it("refuses a value that is not a positive whole number and does not save", () => {
    const onSave = render(view);
    type("maxConcurrentRuns", "0");
    expect(container.querySelector("[data-testid=runtime-limit-error-maxConcurrentRuns]")).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    flushSync(() => saveButton().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("requires the per-run memory budget", () => {
    const onSave = render(view);
    type("runMemoryEstimateMb", "");
    expect(container.querySelector("[data-testid=runtime-limit-error-runMemoryEstimateMb]")?.textContent).toBe(
      "Required",
    );
    expect(saveButton().disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a save error from the server", () => {
    render(view, vi.fn(), false, "Instance admin access required");
    expect(container.textContent).toContain("Instance admin access required");
  });

  it("parses a draft without touching the view", () => {
    expect(
      parseRunLimitsDraft({
        maxConcurrentRuns: "",
        maxStartsPerMinute: " 3 ",
        minFreeMemoryMb: "",
        runMemoryEstimateMb: "300",
      }),
    ).toEqual({
      patch: { maxConcurrentRuns: null, maxStartsPerMinute: 3, minFreeMemoryMb: null, runMemoryEstimateMb: 300 },
      errors: {},
    });
  });
});