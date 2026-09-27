// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardModelsFields,
  compactCardModels,
  isCardModelFieldSupported,
  type ModelPickerRenderer,
} from "./AgentCardModelsFields";

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

const picker: ModelPickerRenderer = ({ value }) => <span data-testid="picker">{value || "Default"}</span>;

function render(adapterType: string, value: unknown, onChange = vi.fn()) {
  flushSync(() => {
    root.render(
      <TooltipProvider>
        <AgentCardModelsFields adapterType={adapterType} value={value} onChange={onChange} renderModelPicker={picker} />
      </TooltipProvider>,
    );
  });
  return onChange;
}

describe("myrmidon(M1) agent card model fields", () => {
  it("stays collapsed for an empty card", () => {
    render("codex_local", {});
    expect(container.textContent).toContain("Additional models");
    expect(container.querySelectorAll("[data-testid=picker]")).toHaveLength(0);
  });

  it("marks every field as unsupported for adapters that do not apply them", () => {
    render("codex_local", { stt: "stt-model" });
    expect(container.textContent?.match(/Not supported by this adapter\./g)).toHaveLength(5);
  });

  it("hermes_local supports everything except a separate video model", () => {
    render("hermes_local", { vision: "vision-model", fallbacks: ["fallback-a"] });
    expect(container.textContent?.match(/Not supported by this adapter\./g)).toHaveLength(1);
    expect(isCardModelFieldSupported("hermes_local", "video")).toBe(false);
    const pickers = [...container.querySelectorAll("[data-testid=picker]")].map((el) => el.textContent);
    expect(pickers).toEqual(["vision-model", "Default", "Default", "Default", "fallback-a"]);
  });

  it("adds a fallback row", () => {
    const onChange = render("hermes_local", { fallbacks: ["fallback-a"] });
    const add = [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Add fallback model"))!;
    flushSync(() => add.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith({ fallbacks: ["fallback-a", ""] });
  });

  it("stores nothing for an untouched card", () => {
    expect(compactCardModels({ vision: " ", stt: "" })).toBeUndefined();
    expect(compactCardModels({ tts: " tts-model " })).toEqual({ tts: "tts-model" });
  });
});
