/**
 * myrmidon(G5): recognize the two frame shapes Hermes draws around its final
 * answer when run WITHOUT `-Q`, so both the UI stdout parser (drop the frame
 * from the live transcript, ui/parse-stdout.ts) and the server-side response
 * cleaner (strip it from the captured final text, server/execute.ts via
 * server/myrmidon-live-progress.ts) can recognize either one.
 *
 * Which shape prints depends on `display.streaming`, which defaults to
 * `true` in the vendor CLI (cli.py `_cli_config_defaults`) and nothing on
 * the myrmidon side overrides:
 *
 * 1. **Streaming box** (the default, successful-turn case) — a hand-rolled
 *    box with rounded-corner glyphs, opened as the first delta arrives and
 *    closed when the turn ends (hermes_cli/cli_stream_mixin.py
 *    `_emit_stream_text`/`_flush_stream`):
 *      header: `╭─{label}{'─' * fill}╮`   (label e.g. "⚕ Hermes")
 *      footer: `╰{'─' * (w - 2)}╯`
 *    Content lines between them carry NO border decoration at all
 *    (`_STREAM_PAD = ""` — "no indent: leading whitespace pollutes
 *    copy/paste"), unlike the Panel case below.
 * 2. **`Panel(box=box.HORIZONTALS)`** — used only when the turn was NOT
 *    already streamed: streaming off, or the turn failed/partial
 *    (hermes_cli/cli_chat_turn_mixin.py `_chat_print_response_panel`,
 *    `already_streamed = self._stream_started and self._stream_box_opened
 *    and not is_error_response`). Also used for the "Out of credits" CTA,
 *    unconditionally.
 *
 * Both verified against the vendored `rich`/prompt_toolkit render (Hermes
 * writes both through prompt_toolkit's `PlainTextOutput` for the streaming
 * box, and through a plain, non-`force_terminal` `rich.Console` for the
 * Panel — both strip ANSI/color once stdout isn't a tty, so no color codes
 * ever reach this text):
 *
 *   rich.box.HORIZONTALS = Box(" ── \n    \n ── \n    \n ── \n ── \n    \n ── \n")
 *
 * Every Panel row — including the title row — gets exactly one border cell
 * of literal " " on each side (`mid_left`/`mid_right` in rich/box.py). A row
 * with no title is a run of the box-drawing "─" (U+2500); Hermes never
 * otherwise prints that character (plain prose uses ASCII "-" or an em
 * dash), so a line made up only of "─" is unambiguously a panel border. The
 * streaming box's `╭`/`╮`/`╰`/`╯` (U+256D/E/F, U+2570) are just as
 * unambiguous — Hermes never otherwise prints them either.
 */

/** A pure horizontal rule: the bottom border, or a title-less top border. */
const PANEL_RULE_LINE_RE = /^─{3,}$/;

/** The top border carrying the panel's title, e.g. `─ ⚕ Hermes ──────…`. */
const PANEL_TITLE_LINE_RE = /^─+\s+.+\s─{2,}$/;

/** The streaming box's rounded-corner header, e.g. `╭─⚕ Hermes────…╮`. */
const STREAM_BOX_HEADER_RE = /^╭─.+╮$/;

/** The streaming box's rounded-corner footer, e.g. `╰────…╯`. */
const STREAM_BOX_FOOTER_RE = /^╰─*╯$/;

/** True for an ALREADY-TRIMMED line that is a panel border rule (no title). */
export function isPanelRuleLine(trimmedLine: string): boolean {
  return PANEL_RULE_LINE_RE.test(trimmedLine);
}

/** True for an ALREADY-TRIMMED line that is a panel's title/top border. */
export function isPanelTitleLine(trimmedLine: string): boolean {
  return PANEL_TITLE_LINE_RE.test(trimmedLine);
}

/** True for an ALREADY-TRIMMED line that is the streaming box's header. */
export function isStreamBoxHeaderLine(trimmedLine: string): boolean {
  return STREAM_BOX_HEADER_RE.test(trimmedLine);
}

/** True for an ALREADY-TRIMMED line that is the streaming box's footer. */
export function isStreamBoxFooterLine(trimmedLine: string): boolean {
  return STREAM_BOX_FOOTER_RE.test(trimmedLine);
}

/**
 * Strip a panel row's single-space left border and any right-side fill
 * (padding to the panel width) plus the single-space right border. This
 * keeps real indentation the response itself carried — e.g. a nested
 * markdown list — instead of a blanket `.trim()`, which would also eat it.
 */
function unwrapPanelRow(line: string): string {
  const withoutLeftBorder = line.length > 0 ? line.slice(1) : line;
  return withoutLeftBorder.replace(/\s+$/, "");
}

/**
 * One recognized frame (Panel or streaming box), as found by
 * `findRichFrames`: `bodyLines` is the frame's own content only — Panel rows
 * already have their one-space border padding unwrapped (see
 * `unwrapPanelRow`); streaming-box rows carry no border padding to begin
 * with and are passed through as-is — the header/footer/title/rule lines
 * themselves are never included.
 */
export interface RichFrame {
  kind: "panel" | "stream";
  bodyLines: string[];
}

/**
 * A `RichFrame` plus where it sits in the scanned text: `title` is the label
 * drawn on the frame's top border (e.g. `⚕ Hermes`, `⚡ Out of credits`), and
 * `startLine`/`endLine` are the 0-based indexes, in `text.split("\n")`, of
 * its top and bottom border lines (both inclusive). Callers that need to look
 * at the text BETWEEN frames (e.g. the `❌` narration lines a failed turn
 * prints right before its error Panel) use these to bound the region.
 */
export interface RichFrameSpan extends RichFrame {
  title: string;
  startLine: number;
  endLine: number;
}

/** The label on a Panel's top border: `─  ⚕ Hermes  ───…` -> `⚕ Hermes`. */
function panelTitleText(trimmedTitleLine: string): string {
  return trimmedTitleLine.replace(/^─+\s+/, "").replace(/\s+─{2,}$/, "").trim();
}

/** The label on a streaming box's header: `╭─ ⚕ Hermes ───…╮` -> `⚕ Hermes`. */
function streamBoxTitleText(trimmedHeaderLine: string): string {
  return trimmedHeaderLine.replace(/^╭─+\s*/, "").replace(/\s*─*╮$/, "").trim();
}

/**
 * myrmidon(G5): find every TERMINATED Panel or streaming-box frame in a
 * block of Hermes stdout, in the order they appear, with each frame's title
 * and line span. An unterminated frame (no matching close marker before the
 * end of text — e.g. stdout truncated by a killed run) is not returned, same
 * as `stripRichPanelFrames`'s "don't guess" rule.
 *
 * A single turn can print more than one frame before the real final answer
 * — each burst of streamed text between tool calls reopens a new streaming
 * box (`_on_tool_gen_start` closes the current one; new text opens another —
 * see this module's doc comment), and a failed/partial turn's error message
 * is a `box.HORIZONTALS` Panel that can follow an earlier, already-streamed
 * partial-progress box in the very same run (see this file's own
 * `myrmidon.test.ts`, "still strips a box.HORIZONTALS Panel … when both
 * formats appear in the same run"), optionally followed by a second Panel
 * with the "Out of credits" call to action. Callers that only want the
 * turn's real answer pick the last frame that is not such a call to action
 * (see myrmidon-live-progress.ts `analyzeLiveTurn`) — everything before it is
 * superseded commentary or progress.
 */
export function findRichFrameSpans(text: string): RichFrameSpan[] {
  const lines = text.split("\n");
  const frames: RichFrameSpan[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (isPanelTitleLine(trimmed)) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isPanelRuleLine(lines[j].trim())) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        const bodyLines: string[] = [];
        for (let k = i + 1; k < close; k++) bodyLines.push(unwrapPanelRow(lines[k]));
        frames.push({ kind: "panel", title: panelTitleText(trimmed), bodyLines, startLine: i, endLine: close });
        i = close + 1;
        continue;
      }
    } else if (isStreamBoxHeaderLine(trimmed)) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isStreamBoxFooterLine(lines[j].trim())) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        frames.push({
          kind: "stream",
          title: streamBoxTitleText(trimmed),
          bodyLines: lines.slice(i + 1, close),
          startLine: i,
          endLine: close,
        });
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return frames;
}

/**
 * Same scan as `findRichFrameSpans`, projected down to the frame kind and
 * body only, for callers that do not care where a frame sits.
 */
export function findRichFrames(text: string): RichFrame[] {
  return findRichFrameSpans(text).map(({ kind, bodyLines }) => ({ kind, bodyLines }));
}

/**
 * Remove every Rich Panel frame (title/top border … bottom border) or
 * streaming box (rounded-corner header … footer) from a block of Hermes
 * stdout. Panel rows get their border padding unwrapped so multi-line/
 * markdown content survives unmangled; streaming-box rows carry no border
 * padding to begin with and pass through as-is. Text outside a recognized
 * frame — including an unterminated one, e.g. stdout truncated by a killed
 * run — passes through unchanged.
 */
export function stripRichPanelFrames(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (isPanelTitleLine(trimmed)) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isPanelRuleLine(lines[j].trim())) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        for (let k = i + 1; k < close; k++) out.push(unwrapPanelRow(lines[k]));
        i = close + 1;
        continue;
      }
      // No closing rule found (e.g. a killed run truncated the panel):
      // fall through and keep the title line as-is rather than guess.
    } else if (isStreamBoxHeaderLine(trimmed)) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isStreamBoxFooterLine(lines[j].trim())) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        for (let k = i + 1; k < close; k++) out.push(lines[k]);
        i = close + 1;
        continue;
      }
      // No closing footer found (e.g. a killed/still-streaming run): fall
      // through and keep the header line as-is rather than guess.
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}
