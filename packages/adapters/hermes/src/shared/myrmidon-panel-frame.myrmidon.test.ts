import { describe, expect, it } from "vitest";

import {
  isPanelRuleLine,
  isPanelTitleLine,
  isStreamBoxFooterLine,
  isStreamBoxHeaderLine,
  stripRichPanelFrames,
} from "./myrmidon-panel-frame.js";

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

/**
 * Builds the streaming box Hermes actually uses for a normal successful turn
 * (`display.streaming: true`, the vendor CLI's default — see
 * myrmidon-panel-frame.ts): a rounded-corner header/footer with NO per-row
 * border decoration (`_STREAM_PAD = ""`, cli.py), unlike the
 * `box.HORIZONTALS` Panel above. `fill` approximates
 * `_status_bar_display_width` (prompt_toolkit's `get_cwidth`) with
 * `.length` — exact for a plain-BMP label like "⚕ Hermes"; only the frame's
 * SHAPE matters for the regex under test, not the precise dash count.
 */
function buildStreamBox(label: string, bodyLines: string[], width = 80): string {
  const fill = width - 2 - label.length;
  const header = `╭─${label}${"─".repeat(Math.max(fill - 1, 0))}╮`;
  const footer = `╰${"─".repeat(width - 2)}╯`;
  return ["", header, ...bodyLines, footer].join("\n");
}

describe("isStreamBoxHeaderLine / isStreamBoxFooterLine", () => {
  it("recognizes the header and footer once trimmed", () => {
    const block = buildStreamBox("⚕ Hermes", ["hi"]);
    const rows = block.split("\n");
    expect(isStreamBoxHeaderLine(rows[1].trim())).toBe(true);
    expect(isStreamBoxFooterLine(rows[rows.length - 1].trim())).toBe(true);
  });

  it("does not cross-match the box.HORIZONTALS Panel frame", () => {
    expect(isStreamBoxHeaderLine("─ ⚕ Hermes ──────")).toBe(false);
    expect(isStreamBoxFooterLine("─".repeat(78))).toBe(false);
    expect(isPanelTitleLine("╭─⚕ Hermes──────╮")).toBe(false);
    expect(isPanelRuleLine("╰──────╯")).toBe(false);
  });

  it("does not mistake the (square-corner) reasoning box for the response's streaming box", () => {
    // `_chat_print_reasoning_box`: ┌─ Reasoning ─…─┐ / └─…─┘ — a DIFFERENT
    // glyph set (U+250C/2510/2514/2518), never confused with ╭╮╰╯.
    expect(isStreamBoxHeaderLine("┌─ Reasoning ──────┐")).toBe(false);
    expect(isStreamBoxFooterLine("└──────┘")).toBe(false);
  });

  it("does not mistake a tool-progress or markdown line for the streaming box", () => {
    expect(isStreamBoxHeaderLine("┊ 💻 $         curl -s https://example.com  0.1s")).toBe(false);
    expect(isStreamBoxHeaderLine("- top level bullet")).toBe(false);
  });
});

describe("stripRichPanelFrames — streaming box (display.streaming: true, the vendor default)", () => {
  it("removes the header/footer and passes bare content lines through unchanged", () => {
    const block = buildStreamBox("⚕ Hermes", ["Done."]);
    // Unlike the Panel case (padding=(1,0) adds a blank row on each side),
    // the streaming box has no blank padding row before the footer — only
    // the leading blank from `_cprint(f"\n{_ACCENT}╭─…")`'s own leading "\n".
    expect(stripRichPanelFrames(block)).toBe("\nDone.");
  });

  it("keeps multi-line content, blank paragraph separators, and markdown bullets (no border to unwrap)", () => {
    const bodyLines = [
      "Fixed the missing null check in the session lookup.",
      "",
      "- Verified with a targeted run",
      "- Updated the changelog entry",
    ];
    const block = buildStreamBox("⚕ Hermes", bodyLines);
    expect(stripRichPanelFrames(block)).toBe(["", ...bodyLines].join("\n"));
  });

  it("preserves a nested markdown list's own indentation", () => {
    const block = buildStreamBox("⚕ Hermes", ["- top item", "  - nested item"]);
    expect(stripRichPanelFrames(block).split("\n")).toContain("  - nested item");
  });

  it("passes surrounding tool-progress lines through untouched", () => {
    const before = '[tool] terminal: curl -s "https://example.com"';
    const after = "[done] ┊ 💻 $         curl -s https://example.com  0.2s (0.2s)";
    const block = buildStreamBox("⚕ Hermes", ["Done."]);
    const text = [before, block, after].join("\n");
    expect(stripRichPanelFrames(text)).toBe([before, "", "Done.", after].join("\n"));
  });

  it("leaves an unterminated streaming box (killed mid-answer) alone instead of guessing", () => {
    const block = buildStreamBox("⚕ Hermes", ["Working on it"]);
    const truncated = block.split("\n").slice(0, 3).join("\n"); // blank + header + first content line, no footer
    expect(stripRichPanelFrames(truncated)).toBe(truncated);
  });

  it("still strips a box.HORIZONTALS Panel (e.g. a failed/partial turn) when both formats appear in the same run", () => {
    // already_streamed is false for an error/partial turn even with
    // streaming on, so _chat_print_response_panel falls back to Panel.
    const streamed = buildStreamBox("⚕ Hermes", ["Partial progress before the error."]);
    const panelBlock = [
      " ─ ⚕ Hermes " + "─".repeat(67) + " ",
      " ".repeat(80),
      " The turn failed partway through.".padEnd(79, " ") + " ",
      " ".repeat(80),
      " " + "─".repeat(78) + " ",
    ].join("\r\n");
    const text = [streamed, panelBlock].join("\n");
    const result = stripRichPanelFrames(text);
    expect(result).toContain("Partial progress before the error.");
    expect(result).toContain("The turn failed partway through.");
    expect(result).not.toMatch(/[╭╮╰╯]/);
    expect(result).not.toMatch(/^─+$/m);
  });
});
