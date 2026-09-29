import { describe, expect, it } from "vitest";

import {
  findRichFrameSpans,
  findRichFrameSpansFromEnd,
  findRichFrames,
  isPanelRuleLine,
  isPanelTitleLine,
  isStreamBoxFooterLine,
  isStreamBoxHeaderLine,
  stripRichPanelFrames,
} from "./myrmidon-panel-frame.js";
import {
  REAL_FAILED_402_WITH_CALL_TO_ACTION,
  REAL_FAILED_429_AFTER_RETRIES,
  REAL_MULTI_TOOL_SUCCESS,
} from "../server/myrmidon-live-progress.real-output.fixtures.js";

/** Terminal cells a string takes: an emoji-presentation glyph is two, everything else here is one. */
function cells(text: string): number {
  let n = 0;
  for (const ch of text) n += /\p{Emoji_Presentation}/u.test(ch) ? 2 : 1;
  return n;
}

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
  // Rich pads the title row to the Panel width in terminal CELLS, so a title with a wide glyph
  // ("⚡ Out of credits") has one code point fewer than the bottom rule.
  const top = ` ${titleSegment}${"─".repeat(Math.max(inner - cells(titleSegment), 0))} `;
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

describe("findRichFrames", () => {
  it("finds no frame in plain text", () => {
    expect(findRichFrames("Just a plain multi-line answer.\n\n- with a bullet")).toEqual([]);
  });

  it("finds a single streaming-box frame with its own content, no border lines", () => {
    const block = buildStreamBox("⚕ Hermes", ["Done."]);
    expect(findRichFrames(block)).toEqual([{ kind: "stream", bodyLines: ["Done."] }]);
  });

  it("finds a single Panel frame with border padding already unwrapped", () => {
    const block = buildPanelBlock("⚕ Hermes", ["Done."]);
    expect(findRichFrames(block)).toEqual([{ kind: "panel", bodyLines: ["", "Done.", ""] }]);
  });

  it("finds both frames, in order, when a streamed box precedes a failed turn's Panel", () => {
    const streamed = buildStreamBox("⚕ Hermes", ["Partial progress before the error."]);
    const panelBlock = buildPanelBlock("⚕ Hermes", ["The turn failed partway through."]);
    const frames = findRichFrames([streamed, panelBlock].join("\n"));
    expect(frames.map((f) => f.kind)).toEqual(["stream", "panel"]);
    expect(frames[0].bodyLines).toEqual(["Partial progress before the error."]);
    expect(frames[1].bodyLines).toEqual(["", "The turn failed partway through.", ""]);
  });

  it("does not return an unterminated trailing frame (killed mid-answer)", () => {
    const complete = buildStreamBox("⚕ Hermes", ["Done."]);
    const truncated = buildStreamBox("⚕ Hermes", ["Still working"]).split("\n").slice(0, 3).join("\n");
    const frames = findRichFrames([complete, truncated].join("\n"));
    expect(frames).toEqual([{ kind: "stream", bodyLines: ["Done."] }]);
  });
});

describe("findRichFrameSpans", () => {
  it("returns the title and the 0-based border line span of each frame", () => {
    const streamed = buildStreamBox("⚕ Hermes", ["Partial progress before the error."]);
    const panelBlock = buildPanelBlock("⚡ Out of credits", ["Add credits."]);
    const text = ["prefix line", streamed, panelBlock].join("\n");
    const lines = text.split("\n");
    const spans = findRichFrameSpans(text);

    expect(spans.map((s) => [s.kind, s.title])).toEqual([
      ["stream", "⚕ Hermes"],
      ["panel", "⚡ Out of credits"],
    ]);
    for (const span of spans) {
      const top = lines[span.startLine].trim();
      const bottom = lines[span.endLine].trim();
      if (span.kind === "stream") {
        expect(isStreamBoxHeaderLine(top)).toBe(true);
        expect(isStreamBoxFooterLine(bottom)).toBe(true);
      } else {
        expect(isPanelTitleLine(top)).toBe(true);
        expect(isPanelRuleLine(bottom)).toBe(true);
      }
    }
    expect(spans[0].endLine).toBeLessThan(spans[1].startLine);
  });

  it("is what findRichFrames projects: same frames, kind and body only", () => {
    const text = [buildStreamBox("⚕ Hermes", ["One."]), buildPanelBlock("⚕ Hermes", ["Two."])].join("\n");
    expect(findRichFrames(text)).toEqual(findRichFrameSpans(text).map(({ kind, bodyLines }) => ({ kind, bodyLines })));
  });

  it("reads the titles off real CLI output: one box per streamed burst, then the answer box", () => {
    const spans = findRichFrameSpans(REAL_MULTI_TOOL_SUCCESS);
    expect(spans.map((s) => [s.kind, s.title])).toEqual([
      ["stream", "⚕ Hermes"],
      ["stream", "⚕ Hermes"],
      ["stream", "⚕ Hermes"],
      ["stream", "⚕ Hermes"],
    ]);
    expect(spans[0].bodyLines.join("\n")).toContain("Let me look at the session lookup code first.");
    expect(spans.at(-1)!.bodyLines.join("\n")).toContain("Fixed the missing null check");
  });

  it("finds both Panels of a real exhausted-credits failure, titled as printed", () => {
    const spans = findRichFrameSpans(REAL_FAILED_402_WITH_CALL_TO_ACTION);
    expect(spans.map((s) => [s.kind, s.title])).toEqual([
      ["panel", "⚕ Hermes"],
      ["panel", "⚡ Out of credits"],
    ]);
  });
});

describe("findRichFrameSpansFromEnd", () => {
  const HEADER = `╭─ ⚕ Hermes ${"─".repeat(80 - 2 - "─ ⚕ Hermes ".length)}╮`;
  const FOOTER = `╰${"─".repeat(78)}╯`;
  const RULE = "─".repeat(40);

  it("finds the same frames as the forward scan on well-formed text, in document order", () => {
    const text = [buildStreamBox("⚕ Hermes", ["One."]), buildPanelBlock("⚕ Hermes", ["Two."])].join("\n");
    expect(findRichFrameSpansFromEnd(text)).toEqual(findRichFrameSpans(text));
  });

  it("agrees with the forward scan on every real capture that has frames", () => {
    for (const capture of [
      REAL_MULTI_TOOL_SUCCESS,
      REAL_FAILED_402_WITH_CALL_TO_ACTION,
      REAL_FAILED_429_AFTER_RETRIES,
    ]) {
      // The prompt echo is a single line here, so the scan sees only real output.
      const spans = findRichFrameSpansFromEnd(capture);
      expect(spans.length).toBeGreaterThan(0);
      expect(spans).toEqual(findRichFrameSpans(capture));
    }
  });

  it("does not let an earlier header that never got its footer swallow the real, later box", () => {
    const text = [
      HEADER,
      "A stream that died before its footer was printed.",
      "  ┊ 💻 $ ls  0.1s",
      HEADER,
      "The real answer.",
      FOOTER,
    ].join("\n");
    const [only] = findRichFrameSpansFromEnd(text);
    expect(findRichFrameSpansFromEnd(text)).toHaveLength(1);
    expect(only.bodyLines).toEqual(["The real answer."]);
    expect(only.startLine).toBe(3);
    // The forward scan pairs the first header with the last footer.
    expect(findRichFrameSpans(text)[0].bodyLines).toContain("The real answer.");
    expect(findRichFrameSpans(text)[0].bodyLines).toContain(HEADER);
  });

  it("skips a lone rule (the turn divider) instead of pairing it with a title higher up", () => {
    const text = [buildPanelBlock("⚕ Hermes", ["First."]), "", RULE, "", buildStreamBox("⚕ Hermes", ["Answer."])].join("\n");
    const spans = findRichFrameSpansFromEnd(text);
    expect(spans.map((s) => [s.kind, s.bodyLines.join("|").trim()])).toEqual([
      ["panel", expect.stringContaining("First.")],
      ["stream", "Answer."],
    ]);
  });

  it("does not return a title or header that has no close below it", () => {
    expect(findRichFrameSpansFromEnd(["─ ⚕ Hermes ─────────", "body with no bottom rule"].join("\n"))).toEqual([]);
    expect(findRichFrameSpansFromEnd([HEADER, "body with no footer"].join("\n"))).toEqual([]);
  });

  it("does not re-examine the inside of a frame it already found", () => {
    // A model answer that draws its own rule line inside the streaming box.
    const text = [HEADER, "Section one", RULE, "Section two", FOOTER].join("\n");
    const spans = findRichFrameSpansFromEnd(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].bodyLines).toEqual(["Section one", RULE, "Section two"]);
  });

  it("is empty for plain text and for empty input", () => {
    expect(findRichFrameSpansFromEnd("just some text\nmore text")).toEqual([]);
    expect(findRichFrameSpansFromEnd("")).toEqual([]);
  });
});

describe("frame widths: model text that only looks like a frame", () => {
  const DIAGRAM = ["╭────────╮", "│ client │", "╰────────╯"];

  it("keeps a rounded diagram inside a streaming answer, whichever scan reads it", () => {
    const body = ["The flow is:", ...DIAGRAM, "Then the server answers."];
    const text = buildStreamBox("⚕ Hermes", body);
    const expected = [{ kind: "stream", title: "⚕ Hermes", bodyLines: body, startLine: 1, endLine: body.length + 2 }];

    expect(findRichFrameSpans(text)).toEqual(expected);
    expect(findRichFrameSpansFromEnd(text)).toEqual(expected);
    expect(stripRichPanelFrames(text)).toBe(["", ...body].join("\n"));
  });

  it("keeps a diagram drawn with a header and footer of its own at the end of the answer", () => {
    const body = ["Layout:", ...DIAGRAM];
    const text = buildStreamBox("⚕ Hermes", body);

    expect(findRichFrameSpansFromEnd(text).map((s) => s.bodyLines)).toEqual([body]);
    expect(stripRichPanelFrames(text)).toBe(["", ...body].join("\n"));
  });

  it("keeps a lone rule line inside a Panel answer", () => {
    const body = ["Summary", "──────", "Details follow."];
    const text = buildPanelBlock("⚕ Hermes", body);

    for (const spans of [findRichFrameSpans(text), findRichFrameSpansFromEnd(text)]) {
      expect(spans).toHaveLength(1);
      expect(spans[0].kind).toBe("panel");
      expect(spans[0].bodyLines).toEqual(["", ...body, ""]);
    }
    expect(stripRichPanelFrames(text)).toBe(["", ...body, ""].join("\n"));
  });

  it("closes a Panel at its own bottom rule, not at a shorter rule of the answer", () => {
    const text = [buildPanelBlock("⚕ Hermes", ["A", "────", "B"]), "after the panel"].join("\r\n");
    // Every row of the Panel comes out unwrapped and none of its two borders is left behind.
    expect(stripRichPanelFrames(text)).toBe(["", "A", "────", "B", "", "after the panel"].join("\n"));
  });

  it("pairs a Panel whose title has a wide glyph by terminal cells", () => {
    const text = buildPanelBlock("⚡ Out of credits", ["Add credits."]);
    const [top, , , , bottom] = text.split("\r\n").map((row) => row.trim());
    // The title row has one code point fewer than the rule, and the same number of cells.
    expect(Array.from(top).length).toBe(Array.from(bottom).length - 1);

    for (const spans of [findRichFrameSpans(text), findRichFrameSpansFromEnd(text)]) {
      expect(spans.map((s) => [s.kind, s.title])).toEqual([["panel", "⚡ Out of credits"]]);
    }
    expect(stripRichPanelFrames(text)).toContain("Add credits.");
    expect(stripRichPanelFrames(text)).not.toMatch(/^─+$/m);
  });

  it("still pairs a header with its footer when both are one width but not the default 80", () => {
    const text = buildStreamBox("⚕ Hermes", ["Narrow terminal."], 40);
    expect(findRichFrameSpans(text).map((s) => s.bodyLines)).toEqual([["Narrow terminal."]]);
    expect(findRichFrameSpansFromEnd(text).map((s) => s.bodyLines)).toEqual([["Narrow terminal."]]);
  });
});
