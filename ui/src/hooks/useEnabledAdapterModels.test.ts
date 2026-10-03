// @vitest-environment jsdom

// myrmidon(1.6.1 MODEL-PROVIDERS D): the agent-card model picker ordering.
// Free models come from the board DB with a pricing badge; they must sort
// ahead of paid ones, alphabetically inside each tier.

import { describe, expect, it } from "vitest";
import type { AdapterModel } from "@/api/agents";
import { sortModelsFreeFirst } from "./useEnabledAdapterModels";

function model(id: string, pricing?: "free" | "paid"): AdapterModel {
  return { id, label: id, ...(pricing ? { pricing } : {}) };
}

describe("sortModelsFreeFirst", () => {
  it("puts free models ahead of paid ones", () => {
    const sorted = sortModelsFreeFirst([
      model("paid-b", "paid"),
      model("free-b", "free"),
      model("paid-a", "paid"),
      model("free-a", "free"),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["free-a", "free-b", "paid-a", "paid-b"]);
  });

  it("sorts unknown-pricing models alphabetically between tiers-free-last", () => {
    // Models without a pricing flag (env bootstrap default) keep the plain
    // alphabetical order; the flag only reorders when it is present.
    const sorted = sortModelsFreeFirst([model("zeta"), model("alpha", "free"), model("beta", "paid")]);
    expect(sorted.map((m) => m.id)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("keeps an equal list stable", () => {
    const input = [model("a", "free"), model("b", "free")];
    expect(sortModelsFreeFirst(input).map((m) => m.id)).toEqual(["a", "b"]);
  });
});
