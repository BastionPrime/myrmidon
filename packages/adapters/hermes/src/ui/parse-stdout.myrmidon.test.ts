import { describe, expect, it } from "vitest";

import { createHermesStdoutParser, parseHermesStdoutLine } from "./parse-stdout.js";

const TS = "2026-09-28T12:00:00.000Z";

/** Same layout as shared/myrmidon-panel-frame.myrmidon.test.ts — see that
 * file for how this was verified against the real `rich`/`prompt_toolkit`
 * render. Kept local: this file is about how the *line-by-line* live
 * transcript parser reacts to each row, not the frame-recognition regexes
 * themselves. */
function buildPanelRows(title: string, bodyLines: string[], width = 80): string[] {
  const inner = width - 2;
  const titleSegment = `─ ${title} `;
  const top = ` ${titleSegment}${"─".repeat(Math.max(inner - titleSegment.length, 0))} `;
  const bottom = ` ${"─".repeat(inner)} `;
  const blank = ` ${" ".repeat(inner)} `;
  const row = (text: string) => ` ${text.padEnd(inner, " ")} `;
  return [top, blank, ...bodyLines.map(row), blank, bottom];
}

describe("parseHermesStdoutLine — G5: Rich Panel frame around the live-progress final answer", () => {
  it("drops the panel's title/top-border row instead of emitting it as assistant garbage", () => {
    const [top] = buildPanelRows("⚕ Hermes", ["Done."]);
    expect(parseHermesStdoutLine(top, TS)).toEqual([]);
  });

  it("drops the panel's bottom-border row", () => {
    const rows = buildPanelRows("⚕ Hermes", ["Done."]);
    const bottom = rows[rows.length - 1];
    expect(parseHermesStdoutLine(bottom, TS)).toEqual([]);
  });

  it("drops a title-less top border too (e.g. a differently-skinned panel)", () => {
    // Same shape as the bottom border: a bare run of box-drawing "─".
    expect(parseHermesStdoutLine(" " + "─".repeat(78) + " ", TS)).toEqual([]);
  });

  it("still surfaces the panel's own content rows as assistant text", () => {
    const rows = buildPanelRows("⚕ Hermes", ["Done, verified with a targeted run."]);
    const result = parseHermesStdoutLine(rows[2], TS); // first content row
    expect(result).toEqual([{ kind: "assistant", ts: TS, text: "Done, verified with a targeted run." }]);
  });

  it("does not drop a real markdown horizontal rule or a bullet line", () => {
    expect(parseHermesStdoutLine("---", TS)).toEqual([{ kind: "assistant", ts: TS, text: "---" }]);
    expect(parseHermesStdoutLine("- a bullet point", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "- a bullet point" },
    ]);
  });

  it("[tool] lines still do not duplicate the paired [done] ┊ tool_call/tool_result", () => {
    expect(parseHermesStdoutLine("[tool] terminal: curl -s https://example.com", TS)).toEqual([]);

    const toolResult = parseHermesStdoutLine(
      "[done] ┊ 💻 $         curl -s https://example.com  0.2s (0.2s)",
      TS,
    );
    expect(toolResult).toHaveLength(2);
    expect(toolResult[0]).toMatchObject({ kind: "tool_call", name: "shell" });
    expect(toolResult[1]).toMatchObject({ kind: "tool_result" });
  });
});

describe("parseHermesStdoutLine — G5: real vendor tool-start line ('preparing') vs. the completion line", () => {
  // Real shapes verified by reading the installed Hermes Agent CLI sources (not the originally
  // assumed "[tool] name: args", which this adapter's invocation never actually reaches — see
  // PREPARING_TOOL_LINE_RE's doc comment in parse-stdout.ts):
  //   start:      _on_tool_gen_start (hermes_cli/cli_stream_mixin.py):
  //                 f"  ┊ {emoji} preparing {tool_name}…"
  //   completion: get_cute_tool_message (agent/display.py) via _on_tool_progress:
  //                 f"┊ 💻 $         {command}  {duration}s"

  it("drops the real 'preparing' start line instead of emitting it as assistant garbage", () => {
    expect(parseHermesStdoutLine("  ┊ ⚡ preparing terminal…", TS)).toEqual([]);
  });

  it("a real tool call (preparing line, then its completion line) emits exactly ONE tool_call/tool_result pair, not two", () => {
    const prepared = parseHermesStdoutLine("  ┊ ⚡ preparing terminal…", TS);
    expect(prepared).toEqual([]);

    const completed = parseHermesStdoutLine('┊ 💻 $         curl -s "https://example.com"  0.2s', TS);
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ kind: "tool_call", name: "shell" });
    expect(completed[1]).toMatchObject({ kind: "tool_result" });
    // The bug this regresses: before recognizing the "preparing" line, it fell through to
    // parseToolCompletionLine and ALSO produced a bogus tool_call/tool_result pair
    // (name: "preparing"), i.e. two pairs total for this one tool call.
  });

  it("recognizes 'preparing' for tool names other than terminal (e.g. a multi-word cute-message tool)", () => {
    expect(parseHermesStdoutLine("  ┊ 🔍 preparing web_search…", TS)).toEqual([]);
  });

  it("does not drop a real assistant message that happens to start with the word 'preparing'", () => {
    expect(parseHermesStdoutLine("┊ 💬 preparing the release notes now.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "preparing the release notes now." },
    ]);
  });
});

describe("parseHermesStdoutLine — G5: streaming box (display.streaming: true, the vendor default)", () => {
  it("drops the streaming box's rounded-corner header", () => {
    expect(parseHermesStdoutLine("╭─⚕ Hermes──────────────────────────────────────────────────────────────╮", TS)).toEqual([]);
  });

  it("drops the streaming box's rounded-corner footer", () => {
    expect(parseHermesStdoutLine("╰──────────────────────────────────────────────────────────────────────────╯", TS)).toEqual([]);
  });

  it("still surfaces the streaming box's own content lines as assistant text (no border to strip)", () => {
    expect(parseHermesStdoutLine("Done, verified with a targeted run.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Done, verified with a targeted run." },
    ]);
  });

  it("does not mistake the square-corner reasoning box for the response's streaming box", () => {
    expect(parseHermesStdoutLine("┌─ Reasoning ──────────────────────────────────────────────────────────┐", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "┌─ Reasoning ──────────────────────────────────────────────────────────┐" },
    ]);
  });
});

describe("parseHermesStdoutLine — G5: vendor CLI's whole-prompt 'Query:' echo", () => {
  it("drops the Query: line instead of emitting it as assistant garbage", () => {
    expect(parseHermesStdoutLine("Query: Fix the missing null check in the session lookup.", TS)).toEqual([]);
  });

  it("does not drop unrelated assistant text that merely mentions a query", () => {
    expect(parseHermesStdoutLine("Here is the query result you asked for.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Here is the query result you asked for." },
    ]);
  });

  it("stateless fallback: still surfaces a wrapped continuation line as garbage assistant text (documented gap; use createHermesStdoutParser for a real live transcript)", () => {
    expect(parseHermesStdoutLine("(the rest of the full prompt, wrapped with no per-line marker)", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "(the rest of the full prompt, wrapped with no per-line marker)" },
    ]);
  });
});

describe("createHermesStdoutParser — G5: suppresses the WHOLE wrapped 'Query:' echo, not just its first line", () => {
  it("drops every wrapped continuation line until a tool-progress line arrives", () => {
    const parser = createHermesStdoutParser();
    expect(parser.parseLine("Query: You are \"agent-a\", an AI agent employee in a Paperclip-managed company.", TS)).toEqual([]);
    expect(parser.parseLine("Continuing the wrapped instructions with no marker of their own.", TS)).toEqual([]);
    expect(parser.parseLine("And a second wrapped continuation line.", TS)).toEqual([]);

    // The first line Hermes prints that unambiguously starts real turn
    // output ends the suppression AND is itself parsed normally.
    const toolResult = parser.parseLine("[done] ┊ 💻 $         curl -s https://example.com  0.2s (0.2s)", TS);
    expect(toolResult).toHaveLength(2);
    expect(toolResult[0]).toMatchObject({ kind: "tool_call", name: "shell" });

    // Suppression is over: ordinary assistant text after the boundary is not dropped.
    expect(parser.parseLine("All fixed. See the PR.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "All fixed. See the PR." },
    ]);
  });

  it("ends suppression at the answer's streaming-box header just as well as at a tool line", () => {
    const parser = createHermesStdoutParser();
    parser.parseLine("Query: entire prompt echoed here", TS);
    parser.parseLine("more wrapped prompt text, still no marker", TS);
    expect(
      parser.parseLine("╭─⚕ Hermes──────────────────────────────────────────────────────────────╮", TS),
    ).toEqual([]); // the header itself is still chrome, dropped by the panel-frame check
    expect(parser.parseLine("Done, verified with a targeted run.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Done, verified with a targeted run." },
    ]);
  });

  it("does not suppress anything when the run never echoes a prompt (quiet mode / already covered format)", () => {
    const parser = createHermesStdoutParser();
    expect(parser.parseLine("┊ 💬 Here is the query result you asked for.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Here is the query result you asked for." },
    ]);
  });

  it("reset() clears mid-echo suppression state, e.g. between separate runs sharing a parser instance", () => {
    const parser = createHermesStdoutParser();
    parser.parseLine("Query: entire prompt echoed here", TS);
    expect(parser.parseLine("still inside the echo", TS)).toEqual([]);

    parser.reset();

    // Without the reset, this would still be swallowed as "inside the echo".
    expect(parser.parseLine("Not part of any echo.", TS)).toEqual([
      { kind: "assistant", ts: TS, text: "Not part of any echo." },
    ]);
  });
});
