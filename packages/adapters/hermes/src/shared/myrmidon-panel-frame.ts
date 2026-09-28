/**
 * myrmidon(G5): recognize the Rich `Panel(..., box=box.HORIZONTALS)` frame
 * Hermes draws around its final answer (and around the "Out of credits" CTA)
 * when run WITHOUT `-Q` (hermes_cli/cli_chat_turn_mixin.py,
 * `_chat_print_response_panel`). Shared by the UI stdout parser (drop the
 * frame from the live transcript, ui/parse-stdout.ts) and the server-side
 * response cleaner (strip it from the captured final text, server/execute.ts
 * via server/myrmidon-live-progress.ts).
 *
 * Verified against the vendored `rich` box style and a real, non-tty render
 * (Hermes writes the panel through prompt_toolkit's `PlainTextOutput`, which
 * strips all ANSI/color before it reaches a pipe, so no color codes ever
 * reach this text):
 *
 *   rich.box.HORIZONTALS = Box(" ── \n    \n ── \n    \n ── \n ── \n    \n ── \n")
 *
 * Every row — including the title row — gets exactly one border cell of
 * literal " " on each side (`mid_left`/`mid_right` in rich/box.py). A row
 * with no title is a run of the box-drawing "─" (U+2500); Hermes never
 * otherwise prints that character (plain prose uses ASCII "-" or an em
 * dash), so a line made up only of "─" is unambiguously a panel border.
 */

/** A pure horizontal rule: the bottom border, or a title-less top border. */
const PANEL_RULE_LINE_RE = /^─{3,}$/;

/** The top border carrying the panel's title, e.g. `─ ⚕ Hermes ──────…`. */
const PANEL_TITLE_LINE_RE = /^─+\s+.+\s─{2,}$/;

/** True for an ALREADY-TRIMMED line that is a panel border rule (no title). */
export function isPanelRuleLine(trimmedLine: string): boolean {
  return PANEL_RULE_LINE_RE.test(trimmedLine);
}

/** True for an ALREADY-TRIMMED line that is a panel's title/top border. */
export function isPanelTitleLine(trimmedLine: string): boolean {
  return PANEL_TITLE_LINE_RE.test(trimmedLine);
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
 * Remove every Rich Panel frame (title/top border … bottom border) from a
 * block of Hermes stdout, unwrapping each inner row's border padding so
 * multi-line/markdown content survives unmangled. Text outside a recognized
 * panel — including an unterminated one, e.g. stdout truncated by a killed
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
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}
