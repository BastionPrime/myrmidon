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
 * Both formats verified by reading the installed Hermes Agent CLI sources
 * (not guessed from the analysis report that first flagged this — see
 * CONVENTIONS.md §"утверждения отчётов — гипотезы").
 */

import { stripRichPanelFrames } from "../shared/myrmidon-panel-frame.js";

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
 */
export function extractLiveSessionId(stdout: string): string | undefined {
  return stdout.match(LIVE_SESSION_ID_REGEX)?.[1];
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

// Re-exported so execute.ts's response cleaning needs a single G5 import.
export { stripRichPanelFrames };
