import { describe, expect, it } from "vitest";

import { isTurnOutputBoundaryLine } from "./myrmidon-turn-output-boundary.js";

describe("isTurnOutputBoundaryLine", () => {
  it("recognizes every documented boundary shape", () => {
    expect(isTurnOutputBoundaryLine('[tool] terminal: curl -s "https://example.com"')).toBe(true);
    expect(isTurnOutputBoundaryLine('[done] ┊ 💻 $         curl -s "https://example.com"  0.2s (0.3s)')).toBe(true);
    expect(isTurnOutputBoundaryLine("┊ 💬 All fixed.")).toBe(true);
    expect(isTurnOutputBoundaryLine("session_id: 20260928_143022_ab12cd")).toBe(true);
    expect(isTurnOutputBoundaryLine("Resume this session with:")).toBe(true);
    expect(isTurnOutputBoundaryLine("─ ⚕ Hermes ──────────────────")).toBe(true); // Panel title row
    expect(isTurnOutputBoundaryLine("──────────────────────────────")).toBe(true); // Panel rule row
    expect(isTurnOutputBoundaryLine("╭─⚕ Hermes──────────────────╮")).toBe(true); // streaming box header
  });

  it("does not treat ordinary prose or a wrapped prompt-echo continuation line as a boundary", () => {
    expect(isTurnOutputBoundaryLine("(the rest of the full prompt, wrapped with no per-line marker)")).toBe(false);
    expect(isTurnOutputBoundaryLine("Fixed the missing null check in the session lookup.")).toBe(false);
    expect(isTurnOutputBoundaryLine("- Verified with a targeted run")).toBe(false);
    expect(isTurnOutputBoundaryLine("")).toBe(false);
  });

  it("requires the exact exit-summary marker, not just a prefix of it", () => {
    expect(isTurnOutputBoundaryLine("Resume this session with: extra trailing text")).toBe(false);
  });
});
