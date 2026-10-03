// packages/shared/src/myrmidon-parallel-helpers.test.ts
//
// myrmidon(PARALLEL-HELPERS): unit tests for the card -> delegation contract.
// These run in the shared package's Vitest suite (no DB, no server): the whole
// point of the module is that the resolution rules are testable in isolation,
// which is what keeps the profile compiler, the agent card UI and the settings
// page honest about the same values.
//
// What is deliberately NOT here: a test asserting a specific default model id.
// The default helper model comes from an env var exactly so no model name is
// pinned by code; the tests cover the shape (empty = inherit), not a literal.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_HELPER_LIMIT,
  DEFAULT_HELPERS_CEILING,
  HELPER_TURN_BUDGET_MAX,
  HELPER_TURN_BUDGET_MIN,
  PARALLEL_HELPERS_CARD_KEY,
  helperCapacityHint,
  helpersCeiling,
  helpersDefault,
  readParallelHelpersCard,
  resolveParallelHelpers,
} from "./myrmidon-parallel-helpers.js";
import { parallelHelpersSettingsSchema } from "./validators/instance.js";

describe("readParallelHelpersCard", () => {
  it("reads the block the agent card stores", () => {
    const card = {
      [PARALLEL_HELPERS_CARD_KEY]: {
        enabled: true,
        maxConcurrent: 4,
        model: "dashscope/qwen3-flash",
        childTurnBudget: 40,
      },
    };
    expect(readParallelHelpersCard(card)).toEqual({
      enabled: true,
      maxConcurrent: 4,
      model: "dashscope/qwen3-flash",
      childTurnBudget: 40,
    });
  });

  it("keeps absent distinguishable from off", () => {
    expect(readParallelHelpersCard({})).toEqual({
      enabled: undefined,
      maxConcurrent: undefined,
      model: undefined,
      childTurnBudget: undefined,
    });
  });

  it("never trusts a card's field types", () => {
    const card = {
      [PARALLEL_HELPERS_CARD_KEY]: {
        enabled: "yes",
        maxConcurrent: "twelve",
        model: "  ",
        childTurnBudget: -3,
      },
    };
    expect(readParallelHelpersCard(card)).toEqual({
      enabled: undefined,
      maxConcurrent: undefined,
      model: undefined,
      childTurnBudget: undefined,
    });
  });

  it("accepts a numeric string for limits the UI may send as text", () => {
    const card = { [PARALLEL_HELPERS_CARD_KEY]: { maxConcurrent: "3" } };
    expect(readParallelHelpersCard(card).maxConcurrent).toBe(3);
  });
});

describe("resolveParallelHelpers", () => {
  it("defaults to helpers off, module default limit, inherit model", () => {
    const resolved = resolveParallelHelpers({}, undefined);
    expect(resolved.enabled).toBe(false);
    expect(resolved.maxConcurrent).toBe(DEFAULT_HELPER_LIMIT);
    expect(resolved.model).toBe("");
    expect(resolved.childTurnBudget).toBeUndefined();
  });

  it("clamps the card's limit to the company ceiling", () => {
    const resolved = resolveParallelHelpers(
      { [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, maxConcurrent: 99 } },
      { maxPerAgent: 5 },
    );
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxConcurrent).toBe(5);
  });

  it("falls back to the default limit when a card asks for zero or less", () => {
    // A card cannot go BELOW the inherited default either: `maxConcurrent: 0`
    // is a malformed value, not a request for "no helpers" (that is `enabled: false`).
    const resolved = resolveParallelHelpers({ [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, maxConcurrent: 0 } }, undefined);
    expect(resolved.maxConcurrent).toBe(DEFAULT_HELPER_LIMIT);
  });

  it("inherits the settings default when the card names no limit", () => {
    const resolved = resolveParallelHelpers({ [PARALLEL_HELPERS_CARD_KEY]: { enabled: true } }, { defaultMaxPerAgent: 3 });
    expect(resolved.maxConcurrent).toBe(3);
  });

  it("never lets the default exceed the ceiling", () => {
    const resolved = resolveParallelHelpers({ [PARALLEL_HELPERS_CARD_KEY]: { enabled: true } }, {
      defaultMaxPerAgent: 8,
      maxPerAgent: 4,
    });
    expect(resolved.maxConcurrent).toBe(4);
  });

  it("clamps the per-helper turn budget into its bounds", () => {
    // 0 is invalid (a child needs at least one turn) so it is dropped, not clamped to 1:
    // clamping would silently change a malformed card into a real budget.
    const low = resolveParallelHelpers(
      { [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, childTurnBudget: 0 } },
      undefined,
    );
    expect(low.childTurnBudget).toBeUndefined();
    const high = resolveParallelHelpers(
      { [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, childTurnBudget: 10_000 } },
      undefined,
    );
    expect(high.childTurnBudget).toBe(HELPER_TURN_BUDGET_MAX);
    const inRange = resolveParallelHelpers(
      { [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, childTurnBudget: HELPER_TURN_BUDGET_MIN + 3 } },
      undefined,
    );
    expect(inRange.childTurnBudget).toBe(HELPER_TURN_BUDGET_MIN + 3);
  });

  it("falls back to the instance default model, then to inherit", () => {
    const fromInstance = resolveParallelHelpers({}, undefined, "dashscope/qwen3-flash");
    expect(fromInstance.model).toBe("dashscope/qwen3-flash");
    const fromCard = resolveParallelHelpers(
      { [PARALLEL_HELPERS_CARD_KEY]: { model: "openrouter/x" } },
      undefined,
      "dashscope/qwen3-flash",
    );
    // The card always wins over the instance default.
    expect(fromCard.model).toBe("openrouter/x");
  });

  it("treats an empty model as inherit, not as an error", () => {
    const resolved = resolveParallelHelpers({ [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, model: "   " } }, undefined);
    expect(resolved.model).toBe("");
  });
});

describe("ceiling helpers", () => {
  it("takes the owner's ceiling as written — no hard cap above it", () => {
    // HELPERS-NO-CAP: the limit comes only from the interface. A value above
    // the old hard cap of 50 is the owner's decision, not a typo to clamp.
    expect(helpersCeiling({ maxPerAgent: 500 })).toBe(500);
    expect(helpersCeiling({ maxPerAgent: 1000 })).toBe(1000);
  });

  it("resolves a card against a ceiling above the old hard cap without clamping", () => {
    const resolved = resolveParallelHelpers(
      { [PARALLEL_HELPERS_CARD_KEY]: { enabled: true, maxConcurrent: 200 } },
      { maxPerAgent: 500 },
    );
    expect(resolved.maxConcurrent).toBe(200);
  });

  it("falls back to the module ceiling when unset", () => {
    expect(helpersCeiling(undefined)).toBe(DEFAULT_HELPERS_CEILING);
    expect(helpersCeiling({ maxPerAgent: 0 })).toBe(DEFAULT_HELPERS_CEILING);
  });

  it("caps the default at the module default when unset", () => {
    expect(helpersDefault(undefined)).toBe(DEFAULT_HELPER_LIMIT);
  });
});

describe("helperCapacityHint", () => {
  it("warns when the requested total exceeds the build slots", () => {
    const hint = helperCapacityHint(
      [
        { enabled: true, maxConcurrent: 4 },
        { enabled: true, maxConcurrent: 4 },
        { enabled: false, maxConcurrent: 9 },
      ],
      { buildSlots: 6 },
    );
    expect(hint.requestedTotal).toBe(8);
    expect(hint.enabledAgents).toBe(2);
    expect(hint.exceedsBuildSlots).toBe(true);
    expect(hint.warning).toContain("above");
  });

  it("stays silent when within the slots", () => {
    const hint = helperCapacityHint([{ enabled: true, maxConcurrent: 2 }], { buildSlots: 8 });
    expect(hint.exceedsBuildSlots).toBe(false);
    expect(hint.warning).toBeNull();
  });

  it("says the slot count is unknown instead of guessing", () => {
    const hint = helperCapacityHint([{ enabled: true, maxConcurrent: 2 }], undefined);
    expect(hint.buildSlots).toBeNull();
    expect(hint.exceedsBuildSlots).toBe(false);
    expect(hint.warning).toContain("not set");
  });
});

describe("parallelHelpersSettingsSchema", () => {
  it("accepts the fields the settings page writes", () => {
    expect(
      parallelHelpersSettingsSchema.safeParse({
        maxPerAgent: 6,
        defaultMaxPerAgent: 2,
        buildSlots: null,
        hostMemoryMb: null,
      }).success,
    ).toBe(true);
  });

  it("accepts a ceiling above any hard cap — the owner sets the limit", () => {
    expect(parallelHelpersSettingsSchema.safeParse({ maxPerAgent: 500 }).success).toBe(true);
    expect(parallelHelpersSettingsSchema.safeParse({ defaultMaxPerAgent: 120 }).success).toBe(true);
  });

  it("rejects a fractional or non-positive ceiling", () => {
    expect(parallelHelpersSettingsSchema.safeParse({ maxPerAgent: 2.5 }).success).toBe(false);
    expect(parallelHelpersSettingsSchema.safeParse({ maxPerAgent: 0 }).success).toBe(false);
  });

  it("rejects unknown keys, like the other general-settings blocks", () => {
    expect(parallelHelpersSettingsSchema.safeParse({ maxPerAgent: 2, extra: true }).success).toBe(false);
  });
});
