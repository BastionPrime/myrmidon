// myrmidon(BOT-TUNING-C): tests for the per-model reasoning effort policy.
import { describe, expect, it } from "vitest";
import { compileHermesProfile, type HermesProfileInput } from "../bot-containers/profile-compiler.js";
import {
  HERMES_GLOBAL_REASONING_EFFORTS,
  effortsForModel,
  effortForModel,
  isEffortAccepted,
} from "./effort-policy.js";

describe("myrmidon(BOT-TUNING-C) effort policy", () => {
  it("GLM models accept only low/high/max; medium is rejected", () => {
    expect(effortsForModel("glm-5.3")).toEqual(["low", "high", "max"]);
    expect(effortsForModel("dashscope/glm-5.3")).toEqual(["low", "high", "max"]);
    expect(effortForModel("glm-5.3", "medium").source).toBe("invalid");
    expect(isEffortAccepted("glm-5.3", "medium")).toBe(false);
    expect(isEffortAccepted("glm-5.3", "high")).toBe(true);
  });

  it("an empty declared effort resolves to the model's safe default, never medium", () => {
    const resolved = effortForModel("glm-5.3", "");
    expect(resolved.value).toBe("high");
    expect(resolved.source).toBe("model_default");
    expect(resolved.value).not.toBe("medium");
  });

  it("a declared value inside the list is passed through lowercased", () => {
    expect(effortForModel("glm-5.3", "Low")).toEqual(
      expect.objectContaining({ value: "low", source: "declared" }),
    );
  });

  it("an unknown model falls back to the global Hermes list and its default", () => {
    const resolved = effortForModel("model-a", "");
    expect(resolved.efforts).toContain("medium");
    expect(resolved.source).toBe("global_default");
    // The global fallback default is a list value, not a hardcoded medium.
    expect(HERMES_GLOBAL_REASONING_EFFORTS).toContain(resolved.value);
    expect(resolved.value).toBe("minimal");
    expect(effortForModel("model-a", "medium").source).toBe("declared");
  });

  it("a registry entry (A/D contract) overrides the static prefixes", () => {
    const entry = { efforts: ["low", "high"] as const, defaultEffort: "low" };
    expect(effortsForModel("model-a", entry)).toEqual(["low", "high"]);
    expect(effortForModel("model-a", "", entry)).toEqual(
      expect.objectContaining({ value: "low", source: "model_default" }),
    );
    // An entry with an empty efforts list falls back to the global list.
    expect(effortsForModel("model-a", { efforts: [] })).toBe(HERMES_GLOBAL_REASONING_EFFORTS);
  });

  it("an invalid declared value is reported, never rewritten", () => {
    const resolved = effortForModel("glm-5.3", "super-high");
    expect(resolved.value).toBe("super-high");
    expect(resolved.source).toBe("invalid");
  });
});

/**
 * myrmidon(BOT-TUNING-C): the contract with the compiler part. The compiler
 * (BOT-RUNTIME-TUNING B) reads adapterConfig.effort through effortForModel:
 * this pins the compiled-config outcome the contract requires — a GLM model
 * with an empty card effort compiles the model's safe default, never a
 * Hermes-global "medium" (which the model rejects and the LLM gateway turns
 * into a silent fallback on every call).
 */
function contractInput(overrides: Partial<HermesProfileInput> = {}): HermesProfileInput {
  return {
    botKey: "agent-a",
    adapterConfig: { model: "glm-5.3" },
    env: {},
    skills: {},
    instructions: "# Role",
    hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" },
    llm: {},
    mcpServers: [],
    maxConcurrentRuns: 2,
    instanceDefaults: {},
    apiServerKey: "fake-api-server-key-0001",
    paperclipApiUrl: "https://example.com",
    paperclipApiKey: "fake-...01",
    ...overrides,
  };
}

describe("myrmidon(BOT-TUNING-C) compiled-config contract with the compiler part", () => {
  it("a GLM model with an empty card effort compiles the model's safe default through the contract", () => {
    const resolved = effortForModel("glm-5.3", "");
    // The value the compiler part writes when the card field is empty:
    // the model default, not the Hermes-global "medium".
    expect(resolved.value).toBe("high");
    expect(resolved.value).not.toBe("medium");
    expect(resolved.source).toBe("model_default");

    // The compiled config carries whatever the contract resolves. Today the
    // compiler (part B zone) omits agent.reasoning_effort for an empty card
    // field, so Hermes would default to "medium" — the exact defect this
    // contract exists to fix. Once B reads effortForModel, the compiled
    // profile contains the model default instead.
    const compiled = compileHermesProfile(contractInput());
    const config = compiled.files.find((f) => f.path === "hermes/config.yaml")!.content;
    expect(config).not.toContain('reasoning_effort: "medium"');
    if (config.includes("reasoning_effort")) {
      expect(config).toContain(`reasoning_effort: "${resolved.value}"`);
    }
  });

  it("a declared effort inside the model list compiles unchanged", () => {
    const compiled = compileHermesProfile(contractInput({
      adapterConfig: { model: "glm-5.3", effort: "low" },
    }));
    const config = compiled.files.find((f) => f.path === "hermes/config.yaml")!.content;
    expect(config).toContain('reasoning_effort: "low"');
  });
});
