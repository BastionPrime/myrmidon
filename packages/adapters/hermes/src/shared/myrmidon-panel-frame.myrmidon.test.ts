import { describe, expect, it } from "vitest";

import { isPanelRuleLine, isPanelTitleLine, stripRichPanelFrames } from "./myrmidon-panel-frame.js";

/**
 * Builds the exact bytes `rich.panel.Panel(..., box=box.HORIZONTALS,
 * padding=(1, N))` produces once rendered through prompt_toolkit's non-tty
 * `PlainTextOutput` (CRLF line endings, no ANSI/color — see
 * myrmidon-panel-frame.ts for the verified layout). `leftPad` mirrors the
 * horizontal Panel padding used for e.g. the "Out of credits" CTA box.
 */
function buildPanelBlock(title: string, bodyLines: string[], opts: { width?: number; leftPad?: number } = {}): string {
  const width = opts.width ?? 80;
  const leftPad = opts.leftPad ?? 0;
  const inner = width - 2;
  const titleSegment = `─ ${title} `;
  const top = ` ${titleSegment}${"─".repeat(Math.max(inner - titleSegment.length, 0))} `;
  const bottom = ` ${"─".repeat(inner)} `;
  const blank = ` ${" ".repeat(inner)} `;
  const row = (text: string) => ` ${(" ".repeat(leftPad) + text).padEnd(inner, " ")} `;
  return [top, blank, ...bodyLines.map(row), blank, bottom].join("\r\n");
}

describe("isPanelTitleLine / isPanelRuleLine", () => {
  it("recognizes a title row once trimmed", () => {
    const block = buildPanelBlock("⚕ Hermes", ["hi"]);
    const [top] = block.split("\r\n");
    expect(isPanelTitleLine(top.trim())).toBe(true);
    expect(isPanelRuleLine(top.trim())).toBe(false);
  });

  it("recognizes a bare rule row once trimmed", () => {
    const block = buildPanelBlock("⚕ Hermes", ["hi"]);
    const rows = block.split("\r\n");
    const bottom = rows[rows.length - 1];
    expect(isPanelRuleLine(bottom.trim())).toBe(true);
    expect(isPanelTitleLine(bottom.trim())).toBe(false);
  });

  it("does not mistake markdown horizontal rules or bullets for a panel frame", () => {
    expect(isPanelRuleLine("---")).toBe(false); // ASCII hyphen, not U+2500
    expect(isPanelRuleLine("— — —")).toBe(false); // em dash
    expect(isPanelTitleLine("- item one")).toBe(false);
    expect(isPanelTitleLine("# Heading with — an em dash —")).toBe(false);
  });

  it("does not mistake a tool-progress line for a panel frame", () => {
    expect(isPanelTitleLine("┊ 💻 $         curl -s https://example.com  0.1s")).toBe(false);
    expect(isPanelRuleLine("┊ 💻 $         curl -s https://example.com  0.1s")).toBe(false);
  });
});

describe("stripRichPanelFrames", () => {
  it("removes the frame and unwraps the border padding from a single-line answer", () => {
    const block = buildPanelBlock("⚕ Hermes", ["Done."]);
    expect(stripRichPanelFrames(block)).toBe("\nDone.\n");
  });

  it("keeps multi-line content, blank paragraph separators, and markdown bullets", () => {
    const bodyLines = [
      "Fixed the missing null check in the session lookup.",
      "",
      "- Verified with a targeted run",
      "- Updated the changelog entry",
    ];
    const block = buildPanelBlock("⚕ Hermes", bodyLines);
    const result = stripRichPanelFrames(block);
    expect(result).toBe(
      [
        "",
        "Fixed the missing null check in the session lookup.",
        "",
        "- Verified with a targeted run",
        "- Updated the changelog entry",
        "",
      ].join("\n"),
    );
  });

  it("preserves a nested markdown list's own indentation (only the border is stripped)", () => {
    const block = buildPanelBlock("⚕ Hermes", ["- top item", "  - nested item"]);
    const result = stripRichPanelFrames(block);
    expect(result.split("\n")).toContain("  - nested item");
  });

  it("passes surrounding tool-progress lines through untouched", () => {
    const before = '[tool] terminal: curl -s "https://example.com"';
    const after = "[done] ┊ 💻 $         curl -s https://example.com  0.2s (0.2s)";
    const block = buildPanelBlock("⚕ Hermes", ["Done."]);
    const text = [before, block, after].join("\n");
    const result = stripRichPanelFrames(text);
    expect(result).toBe([before, "", "Done.", "", after].join("\n"));
  });

  it("strips the wider 'Out of credits' CTA panel, keeping its own left padding", () => {
    const block = buildPanelBlock("⚡ Out of credits", ["Add credits with your provider."], { leftPad: 4 });
    const result = stripRichPanelFrames(block);
    expect(result).toBe(["", "    Add credits with your provider.", ""].join("\n"));
  });

  it("is a no-op when there is no panel", () => {
    const text = "Just a plain multi-line answer.\n\n- with a bullet";
    expect(stripRichPanelFrames(text)).toBe(text);
  });

  it("leaves an unterminated panel (killed run) alone instead of guessing", () => {
    const block = buildPanelBlock("⚕ Hermes", ["Working on it"]);
    const truncated = block.split("\r\n").slice(0, 3).join("\r\n"); // title + blank + first content row, no closing rule
    expect(stripRichPanelFrames(truncated)).toBe(truncated);
  });

  it("matches a real capture: rich.panel.Panel(box=box.HORIZONTALS) through prompt_toolkit's PlainTextOutput", () => {
    // Bytes captured from the vendored `rich`/`prompt_toolkit` in a non-tty
    // subprocess (see myrmidon-panel-frame.ts for how/why), width=80,
    // padding=(1, 0) — exactly how `_chat_print_response_panel` renders the
    // final answer. Kept verbatim (CRLF included) as a regression anchor.
    const real =
      " ─ ⚕ Hermes " +
      "─".repeat(67) +
      " \r\n" +
      " ".repeat(80) +
      "\r\n" +
      " Fixed the missing null check in the session lookup.".padEnd(79, " ") +
      " \r\n" +
      " ".repeat(80) +
      "\r\n" +
      " - Verified with a targeted run".padEnd(79, " ") +
      " \r\n" +
      " - Updated the changelog entry".padEnd(79, " ") +
      " \r\n" +
      " ".repeat(80) +
      "\r\n" +
      " " +
      "─".repeat(78) +
      " \r\n";
    const result = stripRichPanelFrames(real.replace(/\r\n$/, ""));
    expect(result).toBe(
      [
        "",
        "Fixed the missing null check in the session lookup.",
        "",
        "- Verified with a targeted run",
        "- Updated the changelog entry",
        "",
      ].join("\n"),
    );
  });
});
