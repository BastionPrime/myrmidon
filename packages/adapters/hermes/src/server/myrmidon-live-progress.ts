/**
 * myrmidon(G5): hermes_local live progress without forcing `-Q` (quiet mode).
 *
 * Existing agent cards were rolled out with `adapterConfig.quiet: true`,
 * which makes execute.ts pass `-Q` to `hermes chat`. Hermes then nulls every
 * progress callback (cli.py `_configure_quiet_agent`, ~L4369-4381) and
 * prints only the final answer, so the Paperclip run view shows nothing
 * while hermes_local works. Without `-Q`, Hermes streams two lines per tool
 * call — `┊ {emoji} preparing {tool}…` when the call starts
 * (`_on_tool_gen_start`, hermes_cli/cli_stream_mixin.py), then
 * `┊ {emoji} {verb} {detail}  {duration}s` when it completes
 * (`get_cute_tool_message`, agent/display.py) — which `ui/parse-stdout.ts`
 * drops and parses respectively (see its own `PREPARING_TOOL_LINE_RE`
 * comment for why the originally assumed `[tool] …` shape is not what this
 * adapter's invocation actually reaches). Two more things change shape:
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
 * Two consequences of running without `-Q` decide what this module does with
 * the stdout it is handed (see `analyzeLiveTurn`):
 *
 *  - the answer is the LAST frame only. Everything else the CLI prints
 *    around it — the turn divider, earlier streamed boxes, tool lines, diffs,
 *    the prompt echo — is not part of the answer, so it is never taken from
 *    "everything that is not the exit summary";
 *  - the CLI exits 0 whatever happened, so a failed turn is recognized from
 *    the text and reported as an error with an EMPTY answer (the server
 *    builds the run summary and the auto-comment from the answer whatever the
 *    outcome). What real failures print was taken from captured output of the
 *    installed CLI, see myrmidon-live-progress.real-output.fixtures.ts.
 *
 * Both formats verified by reading the installed Hermes Agent CLI sources
 * and by capturing its real output (not guessed from the analysis report
 * that first flagged this — see CONVENTIONS.md §"утверждения отчётов —
 * гипотезы").
 */

import {
  findRichFrameSpans,
  isPanelRuleLine,
  stripRichPanelFrames,
} from "../shared/myrmidon-panel-frame.js";
import type { RichFrame, RichFrameSpan } from "../shared/myrmidon-panel-frame.js";
import { redactSecretsForLog } from "../shared/myrmidon-secret-redaction.js";
import { isTurnOutputBoundaryLine } from "../shared/myrmidon-turn-output-boundary.js";

/**
 * Env flag: ignore `adapterConfig.quiet: true` and run without `-Q`, so the
 * run view shows tool-by-tool progress.
 *
 * Defaults to OFF: a card's own `quiet` setting decides, exactly as before.
 * Without `-Q` the CLI exits 0 even when the turn failed, so the outcome has
 * to be inferred from the text (see `analyzeLiveTurn`); until that inference
 * is confirmed against a real provider on a stand, this is opt-in. Set it to
 * `1`, `true`, `yes` or `on` to enable it.
 */
export const LIVE_PROGRESS_ENV_VAR = "MYRMIDON_HERMES_LIVE_PROGRESS";

const OFF_VALUES = ["0", "false", "no", "off"];
const ON_VALUES = ["1", "true", "yes", "on"];
let warnedAboutUnrecognizedValue = false;

/**
 * True only for an explicit on-list value — matches `resolveHermesQuietMode`'s
 * "default off" contract (see `LIVE_PROGRESS_ENV_VAR`'s doc comment). A value
 * that is neither a recognized on- nor off-spelling (a typo, e.g. `ture`)
 * counts as "off" here, but is logged once so an operator trying to enable
 * this feature with a typo does not have it silently ignored.
 */
function envFlagOptIn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  if (ON_VALUES.includes(normalized)) return true;
  if (!OFF_VALUES.includes(normalized) && !warnedAboutUnrecognizedValue) {
    warnedAboutUnrecognizedValue = true;
    console.warn(
      `[myrmidon] ${LIVE_PROGRESS_ENV_VAR}=${JSON.stringify(value)} is not one of ${JSON.stringify([...ON_VALUES, ...OFF_VALUES])} — treating it as "off" (live progress stays disabled). If you meant to enable it, check for a typo.`,
    );
  }
  return false;
}

/**
 * Whether to pass `-Q` to `hermes chat`, given the card's own
 * `adapterConfig.quiet` value and the instance's live-progress setting.
 */
export function resolveHermesQuietMode(
  configQuiet: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envFlagOptIn(env[LIVE_PROGRESS_ENV_VAR])) return false;
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

/**
 * The interactive exit summary's fixed skeleton (`_print_exit_summary()`,
 * hermes_cli/cli_session_mixin.py): the anchor line, immediately followed by
 * one or two `  hermes --resume <id>`/`  hermes -c "<title>"` hints, a blank
 * separator line, then the `Session:` field:
 *
 *   Resume this session with:
 *     hermes --resume <id>
 *
 *   Session:        <id>
 *   Duration:       <elapsed>
 *   Messages:       <n> (<u> user, <t> tool calls)
 *
 * myrmidon(G5): matching only the anchor line (`^Resume this session
 * with:...$`) is NOT safe to cut on — it is an ordinary English sentence a
 * prompt can legitimately contain (this very file's own doc comments do, and
 * so does this PR's own test data), so a bare match could anchor on the
 * prompt's own text instead of the real exit summary and truncate the real
 * answer that follows it. Requiring the immediate follow-on structure makes
 * an accidental match on free-form text effectively impossible: nothing but
 * `_print_exit_summary()` itself prints a `hermes --resume <id>` hint
 * followed by a blank line and a `Session:` field right after that phrase.
 */
const EXIT_SUMMARY_RE =
  /^Resume this session with:[ \t]*\r?\n(?:[ \t]*hermes (?:--resume|-c)\b[^\r\n]*\r?\n){1,2}[ \t]*\r?\nSession:[ \t]+\S+/m;

/**
 * Index where the real exit summary starts in `stdout`, or undefined when no
 * occurrence of the anchor line is followed by the rest of the fixed
 * skeleton (e.g. a killed run, an unrecognized format, or a look-alike
 * anchor line in the agent's own answer/prompt with no real summary after
 * it). See `EXIT_SUMMARY_RE`'s doc comment for why the whole skeleton, not
 * just the anchor, is required.
 */
function findExitSummaryStart(stdout: string): number | undefined {
  return EXIT_SUMMARY_RE.exec(stdout)?.index;
}

/**
 * Session id from a non-quiet (no `-Q`) run's stdout, or undefined when the
 * exit summary is missing (e.g. a killed run, or an unrecognized format).
 *
 * myrmidon(G5): scoped to the exit-summary tail (from `findExitSummaryStart`
 * onward), not the whole stdout. The agent's own answer is free-form text
 * the model wrote — a coding/ops assistant plausibly discussing sessions,
 * auth, or status fields could produce a line shaped like `Session:   foo`,
 * and a non-global regex's `.match()` returns the FIRST hit in the string.
 * Searching the whole stdout risked matching that instead of the real id
 * from `_print_exit_summary()`, which only ever appears after the validated
 * exit-summary skeleton.
 */
export function extractLiveSessionId(stdout: string): string | undefined {
  const summaryStart = findExitSummaryStart(stdout);
  if (summaryStart === undefined) return undefined;
  return stdout.slice(summaryStart).match(LIVE_SESSION_ID_REGEX)?.[1];
}

/**
 * Cut the interactive exit summary off the end of a non-quiet run's stdout,
 * leaving the tool-progress lines and the answer's Rich Panel intact for
 * `cleanResponse()`/`stripRichPanelFrames()` to reduce to the plain answer.
 */
export function stripExitSummary(stdout: string): string {
  const start = findExitSummaryStart(stdout);
  return start === undefined ? stdout : stdout.slice(0, start);
}

/** The vendor CLI's prompt echo, first line only (cli.py `_run_single_query_mode`). */
const QUERY_ECHO_START_RE = /^Query:\s/;

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

  if (end >= lines.length) {
    // myrmidon(G5): `isTurnOutputBoundaryLine` deliberately only recognizes
    // visually-unique, per-line markers (tool progress, the answer's frame)
    // — it does NOT treat a bare "Resume this session with:" line as
    // sufficient on its own, because that sentence is ordinary English the
    // echoed prompt can legitimately contain (see EXIT_SUMMARY_RE's doc
    // comment). Unlike the shared per-line check, this function sees the
    // WHOLE captured stdout up front (it runs after the child process has
    // already exited, not while it streams), so it can afford the one thing
    // the per-line scan cannot: validating the exit summary's full
    // multi-line skeleton before trusting it as a boundary. This only
    // matters for a turn that reached no tool call and — for whatever
    // reason — never printed the answer's own frame either; in every other
    // case the loop above already found a real boundary before running off
    // the end of `lines`.
    const exitSummaryStart = findExitSummaryStart(stdout);
    if (exitSummaryStart === undefined) return stdout; // no recognized boundary: leave it alone
    end = stdout.slice(0, exitSummaryStart).split("\n").length - 1;
  }

  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** Title of the vendor's billing call-to-action Panel (`_chat_print_response_panel`'s "Out of credits"). */
const OUT_OF_CREDITS_TITLE_RE = /\bOut of credits\b/i;

/** The vendor's `Error:` prefix on an empty-`final_response` fallback message. */
const ERROR_PREFIX_RE = /^Error:/;

/**
 * A turn-loop narration line that says the turn gave up: `❌ Non-retryable
 * client error (HTTP 400). Aborting.`, `❌ API failed after 3 retries — …`,
 * `❌ Billing or credits exhausted — …`, `❌ Max retries … Giving up.` and the
 * like (agent/turn_recovery.py, turn_response_check.py, turn_overflow.py, …).
 * Printed at column 0, outside any frame. Matched on the raw line, not the
 * trimmed one: an indented `❌` belongs to tool output or a diff context row,
 * not to the turn loop.
 */
const TURN_FAILURE_NARRATION_RE = /^❌/;

/** Upper bound for an error message taken from a frame body. */
const MAX_FAILURE_MESSAGE_CHARS = 1000;

/**
 * What `analyzeLiveTurn` concluded about a non-quiet run's stdout (already
 * cut at the exit summary).
 *
 * `answer` is the last frame that is not the billing call to action, and is
 * present only when the turn did NOT fail — a failed turn has no answer, so
 * nothing from its error text can leak into the stored response, the run
 * summary or the auto-comment built from it. `failureMessage` is present iff
 * the turn is judged to have failed.
 */
export interface LiveTurnAnalysis {
  answer: RichFrame | undefined;
  failureMessage: string | undefined;
}

/** True when the last-non-CTA answer panel sits after a turn-loop `❌` narration line. */
function hasFailureNarrationBefore(lines: string[], spans: RichFrameSpan[], answerIdx: number): boolean {
  // The region to look at starts after the previous frame (if any) or, for
  // the first frame, after the turn's own divider — the run of `─` the CLI
  // prints once when a turn starts (cli_chat_turn_mixin.py). Anything before
  // the divider is the vendor's echo of the whole prompt, which can contain
  // any text, so without one of those two anchors nothing is claimed.
  const floor = answerIdx > 0 ? spans[answerIdx - 1].endLine : -1;
  let found = false;
  for (let k = spans[answerIdx].startLine - 1; k > floor; k--) {
    if (isPanelRuleLine(lines[k].trim())) return found; // the turn's divider
    if (TURN_FAILURE_NARRATION_RE.test(lines[k].replace(/\r$/, ""))) found = true;
  }
  return answerIdx > 0 ? found : false;
}

/**
 * The verdict on a non-quiet run's turn: which frame (if any) is the real
 * answer, and whether the turn failed.
 *
 * Without `-Q` the CLI exits 0 whatever happened (`_run_single_query_mode`
 * never calls `sys.exit`; only quiet mode's `_run_quiet_single_query` does),
 * so the only evidence of a failed turn is in the text. Verified against real
 * output of the installed CLI for a multi-tool success and for provider
 * 400/402/429/500 responses: a failed turn never prints the streaming box; it
 * prints its error as a `box.HORIZONTALS` Panel, preceded by `❌` narration
 * lines from the turn loop, and — for exhausted credits — followed by a
 * second Panel titled "Out of credits". The Panel body itself usually does NOT
 * start with `Error:` (that prefix is only the empty-response fallback), so
 * that prefix alone misses nearly every real failure. A turn is judged failed
 * when the answer frame is a Panel and any of these holds:
 *
 *  - the "Out of credits" call-to-action Panel is present (checked even when
 *    the answer is a streaming box: it is only ever printed on failure);
 *  - the Panel body starts with `Error:`;
 *  - a turn-loop `❌` narration line sits between the previous frame (or the
 *    turn's divider) and the Panel.
 *
 * A streaming-box answer is never a failure by itself, whatever it says: it
 * is model prose (`already_streamed` requires "not an error response"). A
 * Panel answer with none of the three markers is accepted as an answer — this
 * is what a successful turn looks like when `display.streaming` is off. The
 * residual risk is a failed turn whose Panel carries no marker at all; that
 * is stored as a normal answer.
 *
 * `answer` is the LAST non-call-to-action frame — everything earlier is the
 * turn divider, superseded streamed commentary and inline tool diffs, none of
 * which sit inside the last frame's own border. No frame means no answer.
 * Pass the stdout with the exit summary already cut off (`stripExitSummary`).
 */
export function analyzeLiveTurn(stdoutBeforeExitSummary: string): LiveTurnAnalysis {
  const lines = stdoutBeforeExitSummary.split("\n");
  const spans = findRichFrameSpans(stdoutBeforeExitSummary);
  const isCallToAction = (f: RichFrameSpan) => f.kind === "panel" && OUT_OF_CREDITS_TITLE_RE.test(f.title);
  const callToAction = spans.filter(isCallToAction);
  let answerIdx = -1;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (!isCallToAction(spans[i])) {
      answerIdx = i;
      break;
    }
  }
  const answerSpan = answerIdx >= 0 ? spans[answerIdx] : undefined;

  let failed = callToAction.length > 0;
  if (!failed && answerSpan && answerSpan.kind === "panel") {
    const firstContentLine = answerSpan.bodyLines.map((l) => l.trim()).find((l) => l.length > 0);
    failed =
      (firstContentLine !== undefined && ERROR_PREFIX_RE.test(firstContentLine)) ||
      hasFailureNarrationBefore(lines, spans, answerIdx);
  }

  if (!failed) {
    return { answer: answerSpan && { kind: answerSpan.kind, bodyLines: answerSpan.bodyLines }, failureMessage: undefined };
  }
  // Word the failure from the error Panel; a streaming-box answer is model
  // prose, not an error message, so a call to action beats it as the source.
  const source = answerSpan?.kind === "panel" ? answerSpan : (callToAction.at(-1) ?? answerSpan);
  const body = source ? source.bodyLines.join("\n").trim() : "";
  const failureMessage =
    body.length > 0
      ? body.slice(0, MAX_FAILURE_MESSAGE_CHARS)
      : "hermes reported a failed turn in live-progress mode without a message";
  return { answer: undefined, failureMessage };
}

// Re-exported so execute.ts's response cleaning needs a single G5 import.
export { stripRichPanelFrames };

/**
 * Per-run, per-stream sanitizer for the raw stdout/stderr chunks forwarded to
 * Paperclip's live/persisted run log (`execute.ts`'s `wrappedOnLog`) while
 * live progress mode is in effect. Fixes two gaps in that path:
 *
 *  - `redactSecretsForLog` only ever saw the raw bytes of a single `data`
 *    event from the child process's pipe, which Node delivers at OS/pipe
 *    read granularity, not at line or token boundaries — a secret that
 *    straddles two events (e.g. `Authorization: Bearer ` in one chunk, the
 *    token in the next) matched nothing in either call. This buffers each
 *    stream's trailing partial line across calls and only redacts complete,
 *    reassembled lines.
 *  - the `Query: <prompt>` echo (see `stripQueryEcho` above) was previously
 *    only cut from the *parsed final response*: every raw chunk of it still
 *    reached the persisted run log, protected only by `redactSecretsForLog`'s
 *    pattern-based redaction — which "can only mask shapes it recognizes"
 *    (../shared/myrmidon-secret-redaction.ts) and would miss a credential
 *    pasted as free prose in the agent's own instructions or the task
 *    markdown. This drops the whole echoed block from the log stream itself,
 *    using the same `isTurnOutputBoundaryLine` scan `stripQueryEcho` uses,
 *    applied incrementally as lines arrive instead of over the whole
 *    (post-hoc) stdout.
 *
 * Construct one instance per run (per `execute()` call) — the suppression
 * flag and the per-stream buffers are run-scoped state, never module-level.
 *
 * myrmidon(G5): unlike `stripQueryEcho`, this processes lines one at a time
 * as they arrive and can never look ahead — so, per `isTurnOutputBoundaryLine`'s
 * doc comment, it does NOT treat a bare exit-summary anchor line as a
 * boundary on its own (only `stripQueryEcho`, which sees the whole captured
 * stdout up front, can safely validate that). The one turn shape this can't
 * recover from is one with no tool call AND, for whatever reason, no
 * Panel/streaming-box frame either — everything after `Query:` would then
 * stay suppressed in this live/persisted log stream for the rest of the
 * run (the STORED response is unaffected: `parseHermesOutput`'s post-hoc
 * `stripQueryEcho` still finds the real, validated exit summary). Accepted:
 * every real turn's final answer is wrapped in one of those two frames
 * (see ../shared/myrmidon-panel-frame.ts), so this is not the normal case.
 */
export interface LiveLogSanitizer {
  /**
   * Feed one raw chunk from `stream`. Returns zero or more complete,
   * sanitized lines (each WITHOUT a trailing newline — the caller decides
   * how to rejoin them) that are safe to forward now; an empty array means
   * nothing is ready yet (still buffering a partial line, or the whole
   * chunk was inside a suppressed `Query:` echo).
   */
  push(stream: "stdout" | "stderr", rawChunk: string): string[];
  /**
   * Call once after the child process has exited (no more chunks are
   * coming): flushes each stream's trailing partial line, redacted and
   * tagged with the stream it came from (the caller still needs that, e.g.
   * to reclassify a benign stderr line as stdout). A partial line still
   * inside an unterminated `Query:` echo (no boundary ever arrived — e.g.
   * the run was killed mid-echo) is dropped rather than forwarded: at that
   * point it can only be echoed prompt, never real turn output.
   */
  flush(): Array<{ stream: "stdout" | "stderr"; line: string }>;
}

export function createLiveLogSanitizer(): LiveLogSanitizer {
  const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  let suppressingQueryEcho = false;

  function sanitizeCompleteLine(stream: "stdout" | "stderr", line: string): string | null {
    const trimmed = line.trim();
    if (stream === "stdout") {
      if (suppressingQueryEcho) {
        if (!isTurnOutputBoundaryLine(trimmed)) return null; // still inside the echo: drop
        suppressingQueryEcho = false; // boundary reached: keep this line, resume normally
      } else if (QUERY_ECHO_START_RE.test(trimmed)) {
        suppressingQueryEcho = true; // drop the "Query:" line itself too
        return null;
      }
    }
    return redactSecretsForLog(line);
  }

  return {
    push(stream, rawChunk) {
      const combined = pending[stream] + rawChunk;
      const lines = combined.split(/\r?\n/);
      pending[stream] = lines.pop() ?? "";
      const out: string[] = [];
      for (const line of lines) {
        const sanitized = sanitizeCompleteLine(stream, line);
        if (sanitized !== null) out.push(sanitized);
      }
      return out;
    },
    flush() {
      const out: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
      for (const stream of ["stdout", "stderr"] as const) {
        const remainder = pending[stream];
        pending[stream] = "";
        if (!remainder) continue;
        if (stream === "stdout" && suppressingQueryEcho) continue; // no boundary ever arrived: drop
        out.push({ stream, line: redactSecretsForLog(remainder) });
      }
      return out;
    },
  };
}
