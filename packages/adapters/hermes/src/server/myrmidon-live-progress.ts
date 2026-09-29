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
 * word-wraps it at the console width, changing only whitespace. The echo is
 * the one place where text of ours can look like the CLI's own output (frames,
 * tool lines, a pasted hermes run with its exit summary), so it is not cut by
 * guessing where "real output" starts: we know the prompt we sent, and
 * ./myrmidon-query-echo.ts cuts the echo where the prompt's own text ends.
 * Everything AFTER that point is the CLI's own output, and only that is looked
 * at for the exit summary, the frames and the failure signals. If the text
 * after `Query:` cannot be aligned with the prompt (the CLI changed it in a way
 * we do not model), nothing after it is trusted and the run fails closed.
 *
 * Consequences of running without `-Q` that decide what this module does with
 * the stdout it is handed (see `analyzeLiveRun`, `analyzeLiveTurn`):
 *
 *  - the answer is the LAST frame only. Everything else the CLI prints
 *    around it — the turn divider, earlier streamed boxes, tool lines, diffs —
 *    is not part of the answer, so it is never taken from "everything that is
 *    not the exit summary";
 *  - the CLI exits 0 whatever happened, so a failed turn is recognized from
 *    the text and reported as an error with an EMPTY answer (the server
 *    builds the run summary and the auto-comment from the answer whatever the
 *    outcome). What real failures print was taken from captured output of the
 *    installed CLI, see myrmidon-live-progress.real-output.fixtures.ts, and
 *    from the vendor source for the branches that set `failed=True` without
 *    any narration (./myrmidon-live-failure-markers.ts);
 *  - a turn that ended with an exit summary but no answer frame at all (a
 *    resumed session that failed to initialize, an exception in `chat()`, an
 *    `@`-context block) is a failure too, not an empty success;
 *  - the vendor's own text is not dropped from the run log: after the echo it
 *    reaches the log as printed (redacted), and an early exit puts its first
 *    lines into the error message.
 *
 * Both formats verified by reading the installed Hermes Agent CLI sources
 * and by capturing its real output (not guessed from the analysis report
 * that first flagged this — see CONVENTIONS.md §"утверждения отчётов —
 * гипотезы").
 */

import {
  findRichFrameSpansFromEnd,
  isPanelRuleLine,
  isPanelTitleLine,
  isStreamBoxHeaderLine,
} from "../shared/myrmidon-panel-frame.js";
import type { RichFrame, RichFrameSpan } from "../shared/myrmidon-panel-frame.js";
import { redactSecretsForLog } from "../shared/myrmidon-secret-redaction.js";
import { isTurnOutputBoundaryLine } from "../shared/myrmidon-turn-output-boundary.js";
import { findVendorFailureMarker } from "./myrmidon-live-failure-markers.js";
import { compileEchoPrompt, EchoMatcher, QUERY_ECHO_LINE_RE, splitQueryEcho } from "./myrmidon-query-echo.js";
import type { QueryEchoState } from "./myrmidon-query-echo.js";

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
 * hermes_cli/cli_session_mixin.py), the LAST thing the CLI prints:
 *
 *   Resume this session with:
 *     hermes --resume <id>
 *     hermes -c "<title>"          (optional)
 *
 *   Session:        <id>
 *   Title:          <title>        (optional)
 *   Duration:       <elapsed>
 *   Messages:       <n> (<u> user, <t> tool calls)
 *
 * myrmidon(G5): the summary is recognized by its WHOLE shape AND by being the
 * end of the output — each field line after `Session:` is `Label: value`, and
 * only whitespace may follow the last one. The anchor sentence alone is not
 * safe (it is ordinary English a prompt or a model answer can contain), and
 * even the whole skeleton can be quoted (a pasted earlier hermes run ends with
 * one). Text the model wrote lies BEFORE the real summary, never after it, so
 * requiring the end of the output means a quoted summary can only win if the
 * real one is missing — and the prompt echo, the one place a whole run gets
 * quoted, is cut off before this is looked at. Callers pass the text after the
 * echo (`splitQueryEcho`), and the LAST match is the only one that can anchor.
 *
 * The price of this precision: a vendor release that prints something after
 * the summary, or a field line not shaped `Label: value`, makes the summary
 * unrecognized and a clean exit is reported as a failure (with the vendor's
 * text in the message). That is the safe direction, and is listed in
 * DIVERGENCE.md.
 */
const EXIT_SUMMARY_TAIL_RE = new RegExp(
  String.raw`(?<![^\n])Resume this session with:[ \t]*\r?\n` +
    String.raw`(?:[ \t]*hermes (?:--resume|-c)\b[^\r\n]*\r?\n){1,2}` +
    String.raw`[ \t]*\r?\n` +
    String.raw`Session:[ \t]+\S+[^\r\n]*` +
    String.raw`(?:\r?\n[A-Z][A-Za-z ]{0,20}:[ \t]+[^\r\n]*)*` +
    String.raw`\s*$`,
);

/** Where the exit summary starts in `text` and the session id it carries, or undefined. */
function findExitSummary(text: string): { start: number; sessionId: string } | undefined {
  const match = EXIT_SUMMARY_TAIL_RE.exec(text);
  if (!match) return undefined;
  const sessionId = text.slice(match.index).match(LIVE_SESSION_ID_REGEX)?.[1];
  return sessionId === undefined ? undefined : { start: match.index, sessionId };
}

/**
 * Session id from a non-quiet (no `-Q`) run's output AFTER the prompt echo, or
 * undefined when the exit summary is missing (e.g. a killed run, an early
 * exit, or an unrecognized format). See `EXIT_SUMMARY_TAIL_RE` for what counts
 * as the summary. The agent's own answer is free-form text — a line shaped
 * `Session:   foo` in it is never taken, because only the summary at the very
 * end is read.
 */
export function extractLiveSessionId(textAfterEcho: string): string | undefined {
  return findExitSummary(textAfterEcho)?.sessionId;
}

/**
 * Cut the interactive exit summary off the end of a non-quiet run's output
 * (after the prompt echo), leaving the tool-progress lines and the answer's
 * frame intact for `analyzeLiveTurn`.
 */
export function stripExitSummary(textAfterEcho: string): string {
  const found = findExitSummary(textAfterEcho);
  return found === undefined ? textAfterEcho : textAfterEcho.slice(0, found.start);
}

/**
 * Remove the vendor CLI's `Query: <prompt>` echo from a non-quiet run's stdout,
 * cutting it exactly by the prompt that was sent (see ./myrmidon-query-echo.ts),
 * and return what the CLI itself printed. When the echo cannot be aligned with
 * the prompt, or the output ends inside it, nothing after the `Query:` line is
 * returned: it cannot be told from echo.
 */
export function stripQueryEcho(stdout: string, prompt: string): string {
  const split = splitQueryEcho(stdout, prompt);
  return split.before + split.after;
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
 * What `analyzeLiveTurn` concluded about a non-quiet run's output (after the
 * prompt echo, before the exit summary).
 *
 * `answer` is the last frame that is not the billing call to action, and is
 * present only when the turn did NOT fail — a failed turn has no answer, so
 * nothing from its error text can leak into the stored response, the run
 * summary or the auto-comment built from it. `failureMessage` is present iff
 * the turn is judged to have failed. Both are undefined when the turn printed
 * no frame at all.
 */
export interface LiveTurnAnalysis {
  answer: RichFrame | undefined;
  failureMessage: string | undefined;
}

/**
 * True when a turn-loop `❌` narration line sits between the answer frame and
 * whatever precedes it: the previous frame's end, or the turn's own divider —
 * the run of `─` the CLI prints once when a turn starts
 * (cli_chat_turn_mixin.py) — or, for the first frame, the start of the text.
 */
function hasFailureNarrationBefore(lines: string[], spans: RichFrameSpan[], answerIdx: number): boolean {
  const floor = answerIdx > 0 ? spans[answerIdx - 1].endLine : -1;
  for (let k = spans[answerIdx].startLine - 1; k > floor; k--) {
    if (isPanelRuleLine(lines[k].trim())) return false; // the turn's divider: nothing above it is this turn
    if (TURN_FAILURE_NARRATION_RE.test(lines[k].replace(/\r$/, ""))) return true;
  }
  return false;
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
 *    turn's divider, or the start of the text) and the Panel;
 *  - the Panel body starts with one of the vendor's turn-ending failure
 *    sentences, which print no narration (`findVendorFailureMarker`).
 *
 * A streaming-box answer is never a failure by itself, whatever it says: it
 * is model prose (`already_streamed` requires "not an error response"). A
 * Panel answer with none of the markers is accepted as an answer — this is
 * what a successful turn looks like when `display.streaming` is off. The
 * residual risk is a failed turn whose Panel carries none of them (see
 * DIVERGENCE.md); that is stored as a normal answer.
 *
 * `answer` is the LAST non-call-to-action frame, found scanning from the end
 * of the text — everything earlier is the turn divider, superseded streamed
 * commentary and inline tool diffs, none of which sit inside the last frame's
 * own border. No frame means no answer and no verdict here; `analyzeLiveRun`
 * decides what that means. Pass the output AFTER the prompt echo with the exit
 * summary already cut off (`stripExitSummary`).
 */
export function analyzeLiveTurn(turnText: string): LiveTurnAnalysis {
  const lines = turnText.split("\n");
  const spans = findRichFrameSpansFromEnd(turnText);
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
      hasFailureNarrationBefore(lines, spans, answerIdx) ||
      findVendorFailureMarker(answerSpan.bodyLines.join("\n")) !== undefined;
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

/** The vendor's message when `--resume` names a session it does not have or cannot resume (cli_agent_setup_mixin.py). */
const STALE_SESSION_RE = /^(?:Session not found|Cannot resume session):/m;

/**
 * What the CLI printed before the turn's own output: the text up to the first
 * turn divider (a bare `─` rule, printed by cli_chat_turn_mixin.py right after
 * `_init_agent` succeeded) or, failing that, the first frame's top border.
 *
 * The CLI reports a resume target it cannot use from `_init_agent`, so ahead of
 * that divider. Anything after it is the turn's own output: a streamed answer,
 * a tool result or a diff that merely quotes the phrase, which says nothing
 * about the stored session.
 */
function textBeforeTurnOutput(output: string): string {
  const lines = output.split(/\r?\n/);
  const end = lines.findIndex((line) => {
    const trimmed = line.trim();
    return isPanelRuleLine(trimmed) || isPanelTitleLine(trimmed) || isStreamBoxHeaderLine(trimmed);
  });
  return end === -1 ? output : lines.slice(0, end).join("\n");
}

/** How many vendor lines an error message quotes, and how long that quote may get. */
const MAX_EXCERPT_LINES = 5;
const MAX_EXCERPT_CHARS = 500;

/** Lines that say nothing about why a run ended: the CLI's own chrome. */
function isExcerptNoise(trimmed: string): boolean {
  return trimmed === "" || trimmed === "Initializing agent..." || trimmed.startsWith("Goodbye!") || isPanelRuleLine(trimmed);
}

/** The first meaningful lines of vendor output, redacted and bounded, for an error message. */
function excerptOf(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (isExcerptNoise(trimmed)) continue;
    kept.push(trimmed);
    if (kept.length >= MAX_EXCERPT_LINES) break;
  }
  return redactSecretsForLog(kept.join(" | ")).slice(0, MAX_EXCERPT_CHARS);
}

function withExcerpt(message: string, text: string): string {
  const excerpt = excerptOf(text);
  return excerpt === "" ? `${message} It printed nothing else.` : `${message} It printed: ${excerpt}`;
}

const ECHO_LOST_MESSAGE =
  "hermes exited 0 in live-progress mode, but the text after its `Query:` line is not the prompt that was sent, " +
  "so nothing it printed could be trusted (the CLI changed how it echoes the query?).";
const EARLY_EXIT_MESSAGE =
  "hermes exited 0 in live-progress mode without printing an exit summary: it stopped before a turn completed " +
  "(missing credentials, a --resume target that was not found, ...) or printed a shape this adapter does not recognize.";
const NO_ANSWER_FRAME_MESSAGE =
  "hermes ended a turn in live-progress mode without printing an answer (the turn failed before it produced one, " +
  "for example a resumed session that could not be initialized).";

/** What `analyzeLiveRun` concluded about one run's captured stdout. */
export interface LiveRunAnalysis {
  /** stdout as the CLI printed it, minus the prompt echo (see `stripQueryEcho`). */
  visibleStdout: string;
  /** How the prompt echo was found. */
  echo: QueryEchoState;
  /** Session id from the exit summary; only from a summary that ends the CLI's own output. */
  sessionId: string | undefined;
  /** The turn's answer frame; absent for a failed turn. */
  answer: RichFrame | undefined;
  /** Set when the run must be recorded as a failure although the CLI exited 0. */
  errorMessage: string | undefined;
  /**
   * The CLI said the `--resume` session is gone or cannot be resumed, before any turn output, and the
   * run then exited cleanly: the stored session id is dead.
   */
  staleSession: boolean;
}

/**
 * Judge a non-quiet run from its captured stdout, the prompt that was sent on
 * stdin, and how the process ended.
 *
 * The output after the echo is examined in this order: no exit summary and a
 * clean exit -> early exit (the vendor's first lines go into the message);
 * exit summary -> `analyzeLiveTurn` on what precedes it, and a turn with no
 * frame at all on a clean exit is a failure too. A run that timed out or exited
 * nonzero gets no verdict of its own here: `execute()` already reports those.
 * When the echo cannot be aligned, a clean exit is a failure and nothing after
 * the `Query:` line is used.
 */
export function analyzeLiveRun(
  rawStdout: string,
  prompt: string,
  run: { timedOut: boolean; exitCode: number | null | undefined },
): LiveRunAnalysis {
  const split = splitQueryEcho(rawStdout, prompt);
  const exitedCleanly = !run.timedOut && run.exitCode === 0;
  const result: LiveRunAnalysis = {
    visibleStdout: split.before + split.after,
    echo: split.state,
    sessionId: undefined,
    answer: undefined,
    errorMessage: undefined,
    staleSession: false,
  };
  if (split.state === "lost") {
    if (exitedCleanly) result.errorMessage = ECHO_LOST_MESSAGE;
    return result;
  }

  const output = split.after;
  const summary = findExitSummary(output);
  if (summary === undefined) {
    // The stored session is stale only when the CLI itself said so before any turn ran (so not in
    // a streamed answer or a tool result that quotes the phrase) and then stopped cleanly. A run
    // that timed out or died says nothing about the session it was resuming.
    result.staleSession = exitedCleanly && STALE_SESSION_RE.test(textBeforeTurnOutput(output));
    if (exitedCleanly) result.errorMessage = withExcerpt(EARLY_EXIT_MESSAGE, output);
    return result;
  }

  result.sessionId = summary.sessionId;
  const turnText = output.slice(0, summary.start);
  const turn = analyzeLiveTurn(turnText);
  if (turn.failureMessage !== undefined) {
    result.errorMessage = turn.failureMessage;
  } else if (turn.answer !== undefined) {
    result.answer = turn.answer;
  } else if (exitedCleanly) {
    result.errorMessage = withExcerpt(NO_ANSWER_FRAME_MESSAGE, turnText);
  }
  return result;
}

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
 *  - the `Query: <prompt>` echo (see the module doc) would otherwise be copied
 *    into the run log, protected only by `redactSecretsForLog`'s
 *    pattern-based redaction — which "can only mask shapes it recognizes"
 *    (../shared/myrmidon-secret-redaction.ts) and would miss a credential
 *    pasted as free prose in the agent's own instructions or the task
 *    markdown. This drops the echoed block from the log stream, cutting it
 *    exactly by the known prompt with the same matcher `stripQueryEcho` uses,
 *    fed line by line as lines arrive.
 *
 * Only the echo is dropped. Everything the CLI prints after it — including the
 * vendor's own message when it stops before a turn ("Session not found", "No
 * API key found ...") — reaches the log, redacted.
 *
 * If the text after `Query:` turns out not to be the prompt (the alignment is
 * lost), the sanitizer falls back to the heuristic this module used before it
 * knew the prompt: drop lines until one that can only be turn output
 * (`isTurnOutputBoundaryLine`). That keeps a possibly secret-bearing echo out of
 * the log at the price of possibly dropping some real output; the stored
 * result is decided separately and fails closed (`analyzeLiveRun`).
 *
 * Construct one instance per run (per `execute()` call) — the phase, the
 * matcher and the per-stream buffers are run-scoped state, never module-level.
 */
export interface LiveLogSanitizer {
  /**
   * Feed one raw chunk from `stream`. Returns zero or more complete,
   * sanitized lines (each WITHOUT a trailing newline — the caller decides
   * how to rejoin them) that are safe to forward now; an empty array means
   * nothing is ready yet (still buffering a partial line, or the whole
   * chunk was inside the `Query:` echo).
   */
  push(stream: "stdout" | "stderr", rawChunk: string): string[];
  /**
   * Call once after the child process has exited (no more chunks are
   * coming): flushes each stream's trailing partial line, redacted and
   * tagged with the stream it came from (the caller still needs that, e.g.
   * to reclassify a benign stderr line as stdout). A partial line still
   * inside an unfinished echo (the run was killed mid-echo) is dropped rather
   * than forwarded: at that point it can only be echoed prompt.
   */
  flush(): Array<{ stream: "stdout" | "stderr"; line: string }>;
}

type EchoPhase = "before-echo" | "in-echo" | "after-echo" | "alignment-lost";

export function createLiveLogSanitizer(prompt: string): LiveLogSanitizer {
  const compiled = compileEchoPrompt(prompt);
  const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  // With no prompt text there is no echo to align against, and nothing to hide.
  let phase: EchoPhase = compiled.significant.length === 0 ? "after-echo" : "before-echo";
  let matcher: EchoMatcher | null = null;

  /** One line of the echo (from index `from`): stay inside, finish it, or lose the alignment. */
  function feedEchoLine(line: string, from: number): string | null {
    const result = matcher!.feed(`${line}\n`, from);
    if (result.status === "more") return null;
    matcher = null;
    if (result.status === "lost") {
      phase = "alignment-lost";
      return null;
    }
    phase = "after-echo";
    const rest = line.slice(Math.min(result.end, line.length));
    return rest.trim() === "" ? null : redactSecretsForLog(rest);
  }

  function sanitizeCompleteLine(stream: "stdout" | "stderr", line: string): string | null {
    if (stream === "stderr") return redactSecretsForLog(line);
    switch (phase) {
      case "before-echo": {
        const start = QUERY_ECHO_LINE_RE.exec(line);
        if (start === null) return redactSecretsForLog(line);
        matcher = new EchoMatcher(compiled);
        phase = "in-echo";
        return feedEchoLine(line, start[0].length);
      }
      case "in-echo":
        return feedEchoLine(line, 0);
      case "alignment-lost":
        if (!isTurnOutputBoundaryLine(line.trim())) return null;
        phase = "after-echo";
        return redactSecretsForLog(line);
      case "after-echo":
        return redactSecretsForLog(line);
    }
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
        if (stream === "stdout" && (phase === "in-echo" || phase === "alignment-lost")) continue; // never left the echo: drop
        out.push({ stream, line: redactSecretsForLog(remainder) });
      }
      return out;
    },
  };
}
