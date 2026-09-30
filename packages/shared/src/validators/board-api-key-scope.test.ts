import { describe, expect, it } from "vitest";
import {
  BOARD_API_KEY_SCOPE_KINDS,
  boardApiKeyScopeSchema,
  createBoardApiKeySchema,
  normalizeBoardApiKeyScope,
} from "./access.js";

// Enforcement behaviour (boardApiKeyScopeAllows / middleware) is covered by
// server/src/__tests__/board-key-scope-middleware.test.ts.

describe("board API key scope validator (myrmidon ROLE-SCOPED-TOKENS)", () => {
  it("accepts every documented scope kind", () => {
    for (const kind of BOARD_API_KEY_SCOPE_KINDS) {
      expect(boardApiKeyScopeSchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it("rejects unknown scope kinds", () => {
    expect(boardApiKeyScopeSchema.safeParse({ kind: "superuser" }).success).toBe(false);
    // Non-strict object: unknown extra keys are stripped, not rejected — same
    // tolerance as the vendor's agent key scope schemas' parent objects.
    const parsed = boardApiKeyScopeSchema.safeParse({ kind: "full", extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ kind: "full" });
  });

  it("normalizes invalid stored values to full access", () => {
    expect(normalizeBoardApiKeyScope(null)).toEqual({ kind: "full" });
    expect(normalizeBoardApiKeyScope(undefined)).toEqual({ kind: "full" });
    expect(normalizeBoardApiKeyScope({ kind: "bogus" })).toEqual({ kind: "full" });
    expect(normalizeBoardApiKeyScope("read_only")).toEqual({ kind: "full" });
  });

  it("createBoardApiKeySchema keeps scope optional and validates kinds", () => {
    // No default: absent scope must stay absent so client wire contracts
    // (CLI payloads parsed through this schema) are unchanged.
    expect(createBoardApiKeySchema.parse({})).not.toHaveProperty("scope");
    expect(createBoardApiKeySchema.parse({ name: "x" })).not.toHaveProperty("scope");
    expect(createBoardApiKeySchema.parse({ name: "x", scope: { kind: "read_only" } }).scope).toEqual({
      kind: "read_only",
    });
    expect(
      createBoardApiKeySchema.safeParse({ name: "x", scope: { kind: "nope" } }).success,
    ).toBe(false);
  });
});
