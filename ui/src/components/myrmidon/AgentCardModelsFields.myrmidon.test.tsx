// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardModelsFields,
  CardContextLengthField,
  CardEffortPicker,
  compactCardModels,
  isCardModelFieldSupported,
  type ModelPickerRenderer,
} from "./AgentCardModelsFields";
import { defaultEffortForModel, effortsForModel } from "@/lib/card-effort-policy";

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

/** React-controlled inputs need the native value setter for a synthetic change. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("myrmidon(M1) agent card model fields", () => {
  it("stays collapsed for an empty card", () => {
    render("codex_local", {});
    expect(container.textContent).toContain("Additional models");
    expect(container.querySelectorAll("[data-testid=picker]")).toHaveLength(0);
  });

  it("marks every field as unsupported for adapters that do not apply them", () => {
    render("codex_local", { stt: "stt-model" });
    // myrmidon(BOT-TUNING-C): four single-model pickers, two auxiliary model
    // pickers, the context-length note and the fallbacks note.
    expect(container.textContent?.match(/Not supported by this adapter\./g)).toHaveLength(8);
  });

  it("hermes_local supports everything except a separate video model", () => {
    render("hermes_local", { vision: "vision-model", fallbacks: ["fallback-a"] });
    expect(container.textContent?.match(/Not supported by this adapter\./g)).toHaveLength(1);
    expect(isCardModelFieldSupported("hermes_local", "video")).toBe(false);
    const pickers = [...container.querySelectorAll("[data-testid=picker]")].map((el) => el.textContent);
    // myrmidon(BOT-TUNING-C): two auxiliary model pickers were added after the
    // single-model ones, before the fallback rows.
    expect(pickers).toEqual([
      "vision-model",
      "Default",
      "Default",
      "Default",
      "Default",
      "Default",
      "fallback-a",
    ]);
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

// myrmidon(BOT-TUNING-C): the new part B fields on the card.
describe("myrmidon(BOT-TUNING-C) card fields for context length and auxiliary models", () => {
  it("reads and writes contextLength on the models block", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <AgentCardModelsFields
            adapterType="hermes_local"
            value={{ contextLength: 128_000, titleGeneration: "title-model", compressionSummary: "compression-model" }}
            onChange={onChange}
            renderModelPicker={picker}
          />
        </TooltipProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>("[data-testid=myrmidon-card-context-length]")!;
    expect(input.value).toBe("128000");
    const pickers = [...container.querySelectorAll("[data-testid=picker]")].map((el) => el.textContent);
    expect(pickers).toContain("title-model");
    expect(pickers).toContain("compression-model");

    setInputValue(input, "64000");
    flushSync(() => {});
    // The change event carries the compacted block.
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last.contextLength).toBe(64_000);
  });

  it("rejects a context length outside the compiled range without writing", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <CardContextLengthField value={128_000} onChange={onChange} />
        </TooltipProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>("[data-testid=myrmidon-card-context-length]")!;
    setInputValue(input, "12");
    flushSync(() => {});
    expect(container.querySelector("[data-testid=myrmidon-card-context-length-error]")).not.toBeNull();
    expect(onChange).not.toHaveBeenCalledWith(12);
  });

  it("compacts the new fields like the model names", () => {
    expect(compactCardModels({ titleGeneration: " title-model ", contextLength: 128_000 })).toEqual({
      titleGeneration: "title-model",
      contextLength: 128_000,
    });
    expect(compactCardModels({ compressionSummary: " " })).toBeUndefined();
  });
});

// myrmidon(BOT-TUNING-C): the effort picker offers only the model's values.
describe("myrmidon(BOT-TUNING-C) card effort picker", () => {
  it("offers only low/high/max for a GLM model, never medium", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <CardEffortPicker model="glm-5.3" value="" onChange={vi.fn()} />
        </TooltipProvider>,
      );
    });
    const efforts = [...container.querySelectorAll("[data-effort]")].map((el) => el.getAttribute("data-effort"));
    expect(efforts).toEqual(["low", "high", "max"]);
    expect(efforts).not.toContain("medium");
  });

  it("marks the model's safe default with a badge", () => {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <CardEffortPicker model="glm-5.3" value="" onChange={vi.fn()} />
        </TooltipProvider>,
      );
    });
    const badge = container.querySelector("[data-effort-default]");
    expect(badge).not.toBeNull();
    expect(badge?.parentElement?.getAttribute("data-effort")).toBe("high");
    expect(container.querySelector("[data-testid=myrmidon-card-effort-hint]")?.textContent).toContain("high");
  });

  it("falls back to the global Hermes list for an unknown model", () => {
    expect(effortsForModel("model-a")).toContain("medium");
    expect(effortsForModel("model-a")).toHaveLength(8);
    expect(defaultEffortForModel("model-a")).toBe("minimal");
  });

  it("clicking an effort reports it; clicking the selected one clears it back to the default", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <CardEffortPicker model="glm-5.3" value="low" onChange={onChange} />
        </TooltipProvider>,
      );
    });
    const high = [...container.querySelectorAll("[data-effort]")].find(
      (el) => el.getAttribute("data-effort") === "high",
    )!;
    flushSync(() => high.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("high");

    const low = [...container.querySelectorAll("[data-effort]")].find(
      (el) => el.getAttribute("data-effort") === "low",
    )!;
    flushSync(() => low.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
