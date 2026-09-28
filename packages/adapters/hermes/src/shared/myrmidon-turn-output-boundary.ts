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
 */

import { TOOL_OUTPUT_PREFIX } from "./constants.js";
import { isPanelRuleLine, isPanelTitleLine, isStreamBoxHeaderLine } from "./myrmidon-panel-frame.js";

/**
 * True for an ALREADY-TRIMMED line that starts real turn output, i.e. is
 * definitely NOT a wrapped continuation of the `Query:` echo: a tool-progress
 * line, the answer's Panel/streaming-box frame, or the interactive exit
 * summary.
 */
export function isTurnOutputBoundaryLine(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith("[tool]") ||
    trimmedLine.startsWith("[done]") ||
    trimmedLine.startsWith(TOOL_OUTPUT_PREFIX) ||
    trimmedLine.startsWith("session_id:") ||
    trimmedLine === "Resume this session with:" ||
    isPanelTitleLine(trimmedLine) ||
    isPanelRuleLine(trimmedLine) ||
    isStreamBoxHeaderLine(trimmedLine)
  );
}
