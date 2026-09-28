/**
 * myrmidon(G5): shared definition of "this line can't be a wrapped
 * continuation of the vendor CLI's `Query: <prompt>` echo".
 *
 * `_run_single_query_mode` (cli.py) prints the ENTIRE stdin payload Paperclip
 * sent (agent instructions + wake context + task markdown) as `Query: …`
 * before the turn starts, and Rich word-wraps that at the console width with
 * no per-line marker of its own. Two independent consumers need to agree on
 * exactly where that echo ends:
 *
 *  - the server-side, whole-stdout stripper (`stripQueryEcho`, this
 *    directory's `../server/myrmidon-live-progress.ts`) that cuts the echo
 *    out of the captured final response and out of the persisted run log
 *    (`execute.ts`'s `wrappedOnLog`, via `createLiveLogSanitizer`);
 *  - the UI's line-at-a-time live transcript parser
 *    (`../ui/parse-stdout.ts`'s `createHermesStdoutParser`).
 *
 * If those two disagreed about the boundary, one side could still show/store
 * echo garbage that the other believes it already removed. Both import this
 * single check instead of keeping their own copy.
 *
 * myrmidon(G5): deliberately narrow. This only recognizes markers that are
 * visually/structurally distinctive — box-drawing frame lines, and
 * `TOOL_OUTPUT_PREFIX`-led tool-progress lines — never a bare, ordinary
 * English line like `session_id:` or `Resume this session with:`. Both of
 * those are sentences a prompt (agent instructions, wake context, task
 * markdown) can legitimately contain verbatim — this repo's own doc
 * comments and test fixtures are proof — so treating either as sufficient
 * on its own let a look-alike line inside the STILL-ECHOING prompt end
 * suppression early and leak the rest of the (unredacted) prompt into the
 * persisted log / live transcript as if it were real turn output. Neither
 * consumer of this function can safely recover from that by looking ahead:
 * both process one line at a time as it arrives (the log sanitizer and the
 * live UI transcript are real streaming consumers; a genuinely bare
 * `Resume this session with:` — with no follow-on lines to check yet — is
 * exactly the ambiguous case). The one caller that captures the whole
 * stdout up front (`stripQueryEcho`, ../server/myrmidon-live-progress.ts)
 * additionally validates the exit summary's full multi-line skeleton via
 * its own `EXIT_SUMMARY_RE` as a safety net for the rare case where no
 * marker recognized here ever appears before it.
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
