// myrmidon(D1): pure unit test for chatReconcileMinimumSpacingMs. See
// docs/myrmidon/DIVERGENCE.md.
import { describe, expect, it } from "vitest";
import { chatReconcileMinimumSpacingMs } from "./reconcile-interval.js";

describe("chatReconcileMinimumSpacingMs", () => {
  it("is unset by default, leaving today's spacing untouched", () => {
    expect(chatReconcileMinimumSpacingMs({})).toBeUndefined();
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: undefined })).toBeUndefined();
  });

  it("parses a positive value", () => {
    expect(
      chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "15000" }),
    ).toBe(15000);
  });

  it("ignores zero, negative, and unparseable values", () => {
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "0" })).toBeUndefined();
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "-1" })).toBeUndefined();
    expect(chatReconcileMinimumSpacingMs({ MYRMIDON_CHAT_RECONCILE_INTERVAL_MS: "nope" })).toBeUndefined();
  });
});
