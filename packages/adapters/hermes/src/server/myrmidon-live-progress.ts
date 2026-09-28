/**
 * myrmidon(G5): hermes_local live progress without forcing `-Q` (quiet mode).
 *
 * Existing agent cards were rolled out with `adapterConfig.quiet: true`,
 * which makes execute.ts pass `-Q` to `hermes chat`. Hermes then nulls every
 * progress callback (cli.py `_configure_quiet_agent`, ~L4369-4381) and
 * prints only the final answer, so the Paperclip run view shows nothing
 * while hermes_local works. Without `-Q`, Hermes streams "[tool] …" /
 * "[done] ┊ …" lines that `ui/parse-stdout.ts` already understands — but two
 * things change shape:
 *
 *  - the final answer is wrapped in a Rich Panel (see
 *    ../shared/myrmidon-panel-frame.ts for the frame format and stripping);
 *  - the session id line moves. Quiet mode prints `session_id: <id>` to
 *    *stderr* (cli.py `_run_quiet_single_query`, ~L4079 and ~L4103). Without
 *    `-Q`, `chat()` never prints that line at all — the id only shows up
 *    later, on *stdout*, inside the interactive exit summary that
 *    `_print_exit_summary()` (hermes_cli/cli_session_mixin.py, ~L1272-1334)
 *    prints once the turn is done:
 *
 *      Resume this session with:
 *        hermes --resume <id>
 *
 *      Session:        <id>
 *      Duration:       <elapsed>
 *      Messages:       <n> (<u> user, <t> tool calls)
 *
 *    That block is interactive-CLI chrome, not part of the answer, so it is
 *    cut from the response text the same way the panel frame is.
 *
 * A third thing is new in live-progress mode: `_run_single_query_mode`
 * (cli.py) echoes the WHOLE prompt to stdout before the turn starts —
 * `cli.console.print(f"[bold blue]Query:[/] {_escape(_query_label)}")`,
 * where `_query_label` is the entire stdin payload Paperclip sent (agent
 * instructions + wake context + task markdown), not a short title. `-Q`
 * never reaches this line (`_run_quiet_single_query` exits first), so it is
 * new production behavior once quiet is bypassed. Rich's `Console.print`
 * word-wraps a long string at the console width with no marker of its own,
 * so `stripQueryEcho` below cuts from that line up to the first line that
 * starts real turn output (tool progress, the answer frame, or the exit
 * summary) rather than trying to reconstruct the wrapped text.
 *
 * Both formats verified by reading the installed Hermes Agent CLI sources
 * (not guessed from the analysis report that first flagged this — see
 * CONVENTIONS.md §"утверждения отчётов — гипотезы").
 */

import { TOOL_OUTPUT_PREFIX } from "../shared/constants.js";
import {
  isPanelRuleLine,
  isPanelTitleLine,
  isStreamBoxHeaderLine,
  stripRichPanelFrames,
} from "../shared/myrmidon-panel-frame.js";

/**
 * Env flag: ignore `adapterConfig.quiet: true` and always run without `-Q`.
 * Defaults to on so the ~51 existing agent cards do not need editing one by
 * one; set to a falsy value to restore the previous quiet-follows-the-card
 * behavior.
 */
export const LIVE_PROGRESS_ENV_VAR = "MYRMIDON_HERMES_LIVE_PROGRESS";

function envFlagDefaultOn(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return true;
  return !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Whether to pass `-Q` to `hermes chat`, given the card's own
 * `adapterConfig.quiet` value and the instance's live-progress setting.
 */
export function resolveHermesQuietMode(
  configQuiet: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envFlagDefaultOn(env[LIVE_PROGRESS_ENV_VAR])) return false;
  return configQuiet;
}

/**
 * Quiet mode (`-Q`): `session_id: <id>` on stderr
 * (cli.py `_run_quiet_single_query`). Documented here for the record —
 * execute.ts's existing quiet-mode extraction already covers this format via
 * its stdout+stderr "legacy" fallback; this module does not re-wire it.
 */
export const QUIET_SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/**
 * Live progress (no `-Q`): the exit summary's `Session:        <id>` line,
 * printed to stdout by `_print_exit_summary()`.
 */
export const LIVE_SESSION_ID_REGEX = /^Session:[ \t]+(\S+)/m;

/** First line of the interactive exit summary — everything from here on is
 * CLI chrome, never part of the answer. */
const EXIT_SUMMARY_START_RE = /^Resume this session with:[ \t]*$/m;

/**
 * Session id from a non-quiet (no `-Q`) run's stdout, or undefined when the
 * exit summary is missing (e.g. a killed run, or an unrecognized format).
 *
 * myrmidon(G5): scoped to the exit-summary tail (from `EXIT_SUMMARY_START_RE`
 * onward), not the whole stdout. The agent's own answer is free-form text
 * the model wrote — a coding/ops assistant plausibly discussing sessions,
 * auth, or status fields could produce a line shaped like `Session:   foo`,
 * and a non-global regex's `.match()` returns the FIRST hit in the string.
 * Searching the whole stdout risked matching that instead of the real id
 * from `_print_exit_summary()`, which only ever appears after `Resume this
 * session with:`.
 */
export function extractLiveSessionId(stdout: string): string | undefined {
  const summaryStart = EXIT_SUMMARY_START_RE.exec(stdout);
  if (!summaryStart) return undefined;
  return stdout.slice(summaryStart.index).match(LIVE_SESSION_ID_REGEX)?.[1];
}

/**
 * Cut the interactive exit summary off the end of a non-quiet run's stdout,
 * leaving the tool-progress lines and the answer's Rich Panel intact for
 * `cleanResponse()`/`stripRichPanelFrames()` to reduce to the plain answer.
 */
export function stripExitSummary(stdout: string): string {
  const match = EXIT_SUMMARY_START_RE.exec(stdout);
  return match ? stdout.slice(0, match.index) : stdout;
}

/** The vendor CLI's prompt echo, first line only (cli.py `_run_single_query_mode`). */
const QUERY_ECHO_START_RE = /^Query:\s/;

/**
 * True for an ALREADY-TRIMMED line that starts real turn output, i.e. is
 * definitely NOT a wrapped continuation of the `Query:` echo: a tool-progress
 * line, the answer's Panel/streaming-box frame, or the interactive exit
 * summary. Used by `stripQueryEcho` to find where the echo ends without
 * having to reconstruct Rich's word-wrapping.
 */
function isTurnOutputBoundaryLine(trimmedLine: string): boolean {
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

/**
 * Cut the vendor CLI's `Query: <prompt>` echo off the front of a non-quiet
 * run's stdout. `_query_label` is the ENTIRE prompt Paperclip sent on stdin
 * (agent instructions + wake context + task markdown), and `cli.console.print`
 * word-wraps it at the console width with no per-line marker — so instead of
 * matching the echoed text itself, this cuts from the `Query:` line up to the
 * first line that unambiguously starts real turn output.
 *
 * If no such boundary is found before the end of stdout (e.g. a run killed
 * before any tool call, reasoning, or answer text printed), this is a no-op:
 * leaving the echo in a mangled response is safer than a wrong guess that
 * could delete the real answer along with it.
 */
export function stripQueryEcho(stdout: string): string {
  const lines = stdout.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || !QUERY_ECHO_START_RE.test(lines[start].trim())) return stdout;

  let end = start + 1;
  while (end < lines.length && !isTurnOutputBoundaryLine(lines[end].trim())) end++;
  if (end >= lines.length) return stdout; // no recognized boundary: leave it alone

  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

// Re-exported so execute.ts's response cleaning needs a single G5 import.
export { stripRichPanelFrames };
