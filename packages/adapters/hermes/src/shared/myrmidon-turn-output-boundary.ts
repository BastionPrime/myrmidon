/**
 * myrmidon(G5): shared definition of "this line can't be a wrapped
 * continuation of the vendor CLI's `Query: <prompt>` echo".
 *
 * `_run_single_query_mode` (cli.py) prints the ENTIRE stdin payload Paperclip
 * sent (agent instructions + wake context + task markdown) as `Query: …`
 * before the turn starts, and Rich word-wraps that at the console width with
 * no per-line marker of its own.
 *
 * myrmidon(G5): the server side no longer guesses where that echo ends: it
 * knows the prompt it sent and cuts the echo exactly by it
 * (`../server/myrmidon-query-echo.ts`), which is the only sound way — an echo
 * can hold anything, including whole pasted hermes runs. This line-shape check
 * is what remains for the two places that cannot do that:
 *
 *  - the UI's line-at-a-time live transcript parser
 *    (`../ui/parse-stdout.ts`'s `createHermesStdoutParser`), which sees only
 *    log lines and never the prompt; for a run recorded by the current
 *    adapter the echo is already gone from the log, so this only matters for
 *    a log that still contains one;
 *  - the run-log sanitizer's FALLBACK (`createLiveLogSanitizer`), used only
 *    after the text following `Query:` turned out not to be the prompt that
 *    was sent (the alignment is lost): it then keeps dropping lines until one
 *    that can only be turn output, trading possibly dropped real output for
 *    not leaking a possibly secret-bearing echo into the log.
 *
 * Being a heuristic it can be fooled by an echo that quotes a frame or a
 * tool-progress line; that is exactly why the server does not rely on it.
 *
 * Deliberately narrow. This only recognizes markers that are
 * visually/structurally distinctive — box-drawing frame lines, and
 * `TOOL_OUTPUT_PREFIX`-led tool-progress lines — never a bare, ordinary
 * English line like `session_id:` or `Resume this session with:`. Both of
 * those are sentences a prompt (agent instructions, wake context, task
 * markdown) can legitimately contain verbatim — this repo's own doc
 * comments and test fixtures are proof — so treating either as sufficient
 * on its own would end suppression early on a look-alike line inside the
 * STILL-ECHOING prompt. Neither remaining consumer can look ahead: both
 * process one line at a time as it arrives.
 */

import { TOOL_OUTPUT_PREFIX } from "./constants.js";
import { isPanelRuleLine, isPanelTitleLine, isStreamBoxHeaderLine } from "./myrmidon-panel-frame.js";

/**
 * True for an ALREADY-TRIMMED line that starts real turn output, i.e. is
 * definitely NOT a wrapped continuation of the `Query:` echo: a tool-progress
 * line, or the answer's Panel/streaming-box frame. See the module doc
 * comment above for why a bare `session_id:`/`Resume this session with:`
 * line is deliberately NOT included.
 */
export function isTurnOutputBoundaryLine(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith("[tool]") ||
    trimmedLine.startsWith("[done]") ||
    trimmedLine.startsWith(TOOL_OUTPUT_PREFIX) ||
    isPanelTitleLine(trimmedLine) ||
    isPanelRuleLine(trimmedLine) ||
    isStreamBoxHeaderLine(trimmedLine)
  );
}
