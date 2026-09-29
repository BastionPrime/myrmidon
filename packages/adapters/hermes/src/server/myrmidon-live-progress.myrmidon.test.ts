import { describe, expect, it } from "vitest";

import {
  analyzeLiveTurn,
  createLiveLogSanitizer,
  extractLiveSessionId,
  LIVE_PROGRESS_ENV_VAR,
  LIVE_SESSION_ID_REGEX,
  QUIET_SESSION_ID_REGEX,
  resolveHermesQuietMode,
  stripExitSummary,
  stripQueryEcho,
} from "./myrmidon-live-progress.js";
import {
  REAL_EARLY_EXIT_NO_CREDENTIALS,
  REAL_EARLY_EXIT_SESSION_NOT_FOUND,
  REAL_FAILED_400,
  REAL_FAILED_402_WITH_CALL_TO_ACTION,
  REAL_FAILED_429_AFTER_RETRIES,
  REAL_FAILED_500_AFTER_RETRIES,
  REAL_MULTI_TOOL_SUCCESS,
  REAL_SIMPLE_SUCCESS,
} from "./myrmidon-live-progress.real-output.fixtures.js";

describe("resolveHermesQuietMode", () => {
  it("follows the card's own quiet setting when the env flag is unset (default off)", () => {
    expect(resolveHermesQuietMode(true, {})).toBe(true);
    expect(resolveHermesQuietMode(false, {})).toBe(false);
  });

  it("follows the card's own quiet setting for an empty or whitespace-only value", () => {
    for (const v of ["", "  "]) {
      expect(resolveHermesQuietMode(true, { [LIVE_PROGRESS_ENV_VAR]: v })).toBe(true);
    }
  });

  it("ignores adapterConfig.quiet=true only for an explicit opt-in value", () => {
    for (const v of ["1", "true", "yes", "on", " TRUE ", "On"]) {
      expect(resolveHermesQuietMode(true, { [LIVE_PROGRESS_ENV_VAR]: v })).toBe(false);
    }
  });

  it("also leaves a card that left quiet unset non-quiet when opted in (unaffected either way)", () => {
    expect(resolveHermesQuietMode(false, { [LIVE_PROGRESS_ENV_VAR]: "1" })).toBe(false);
  });

  it("keeps the card's quiet setting for an explicit off value or an unrecognized one (a typo must not enable it)", () => {
    for (const v of ["0", "false", "No", "OFF", "banana", "ture"]) {
      expect(resolveHermesQuietMode(true, { [LIVE_PROGRESS_ENV_VAR]: v })).toBe(true);
      expect(resolveHermesQuietMode(false, { [LIVE_PROGRESS_ENV_VAR]: v })).toBe(false);
    }
  });
});

describe("session id — quiet vs. live progress format", () => {
  it("QUIET_SESSION_ID_REGEX matches -Q's stderr line (cli.py _run_quiet_single_query)", () => {
    const stderr = "some MCP init noise\n\nsession_id: 20260928_143022_ab12cd\n";
    expect(stderr.match(QUIET_SESSION_ID_REGEX)?.[1]).toBe("20260928_143022_ab12cd");
  });

  it("LIVE_SESSION_ID_REGEX matches the non-quiet exit summary's stdout line", () => {
    const stdout = "Session:        20260928_143022_ab12cd\nDuration:       12s\n";
    expect(stdout.match(LIVE_SESSION_ID_REGEX)?.[1]).toBe("20260928_143022_ab12cd");
  });

  it("the two formats do not cross-match", () => {
    expect("session_id: abc123".match(LIVE_SESSION_ID_REGEX)).toBeNull();
    expect("Session:        abc123".match(QUIET_SESSION_ID_REGEX)).toBeNull();
  });
});

/** A realistic non-quiet (`-Q`-less) `_print_exit_summary()` tail, as printed
 * to stdout after `chat()` returns (hermes_cli/cli_session_mixin.py:
 * `print("Resume this session with:")` is immediately followed — no blank
 * line — by `print(f"  hermes --resume {id}...")`; the blank line comes
 * AFTER the resume hint(s), before the `Session:` field). */
function buildExitSummary(sessionId: string): string {
  return [
    "",
    "Resume this session with:",
    `  hermes --resume ${sessionId}`,
    "",
    `Session:        ${sessionId}`,
    "Duration:       12s",
    "Messages:       4 (2 user, 2 tool calls)",
  ].join("\n");
}

describe("extractLiveSessionId", () => {
  it("reads the id out of a realistic exit summary", () => {
    const stdout = "[hermes] Starting Hermes Agent\n" + buildExitSummary("20260928_143022_ab12cd");
    expect(extractLiveSessionId(stdout)).toBe("20260928_143022_ab12cd");
  });

  it("returns undefined for quiet-mode stdout (no exit summary line)", () => {
    expect(extractLiveSessionId("Just the final response.\n")).toBeUndefined();
  });

  it("does NOT match a 'Session:'-shaped line inside the agent's own answer", () => {
    // A coding/ops assistant's own answer text could plausibly contain a
    // line shaped like the exit summary's `Session:  <id>` — e.g. reporting
    // on some unrelated session/auth field. Before scoping to the exit
    // summary tail, `.match()` (non-global) returned this FIRST hit instead
    // of the real id that follows it.
    const fakeSessionLine = "Session:        not-the-real-session-id";
    const stdout = [
      "The user's auth session looks like this:",
      "",
      fakeSessionLine,
      "",
      "That field is unrelated to this CLI run.",
    ].join("\n") + buildExitSummary("20260928_143022_ab12cd");
    expect(extractLiveSessionId(stdout)).toBe("20260928_143022_ab12cd");
  });

  it("returns undefined (not a false positive) when the answer contains a look-alike line but no real exit summary follows (killed run)", () => {
    const stdout = [
      "Reporting on a field:",
      "Session:        not-the-real-session-id",
    ].join("\n");
    expect(extractLiveSessionId(stdout)).toBeUndefined();
  });

  it("does NOT anchor on a bare 'Resume this session with:' line inside the agent's own answer", () => {
    // "Resume this session with:" is itself ordinary English a coding/ops assistant could write
    // while discussing Hermes sessions (exactly this PR's own subject matter) — a lone line
    // match must not be trusted; only the FULL skeleton (hint line, blank, Session:/Duration:/
    // Messages:) that `_print_exit_summary()` actually prints identifies the real one.
    const stdout = [
      "Here's how session resume works in Hermes:",
      "",
      "Resume this session with:",
      "  (this is just documentation prose, not a real exit summary)",
      "",
      "That's the whole mechanism.",
    ].join("\n") + buildExitSummary("20260928_143022_ab12cd");
    expect(extractLiveSessionId(stdout)).toBe("20260928_143022_ab12cd");
  });
});

describe("stripExitSummary", () => {
  it("cuts everything from 'Resume this session with:' onward", () => {
    const body = "[tool] terminal: curl\n[done] ┊ 💻 $         curl  0.1s\n\nDone.\n";
    // buildExitSummary()'s own leading blank print() line lands right after body.
    const stdout = body + buildExitSummary("20260928_143022_ab12cd");
    expect(stripExitSummary(stdout)).toBe(body + "\n");
  });

  it("is a no-op when there is no exit summary (killed run, or quiet mode)", () => {
    const stdout = "Just the final response, no CLI chrome after it.\n";
    expect(stripExitSummary(stdout)).toBe(stdout);
  });

  it("does NOT truncate at a bare 'Resume this session with:' line inside the answer — cuts at the real exit summary instead", () => {
    // Regression for the critical false-positive: a lone `.exec()` match on the anchor line
    // used to cut here, silently discarding the rest of the real answer below it.
    const answerBody = [
      "Here's how session resume works in Hermes:",
      "",
      "Resume this session with:",
      "  (just documentation prose, not the real exit summary)",
      "",
      "That's the whole mechanism — verified by reading cli_session_mixin.py.",
    ].join("\n");
    const stdout = answerBody + buildExitSummary("20260928_143022_ab12cd");
    const stripped = stripExitSummary(stdout);
    expect(stripped).toBe(answerBody + "\n");
    expect(stripped).toContain("verified by reading cli_session_mixin.py");
  });
});

describe("stripQueryEcho", () => {
  it("cuts a single-line Query echo up to the first tool-progress line", () => {
    const stdout = [
      "Query: Fix the missing null check in the session lookup.",
      '[tool] terminal: curl -s "https://example.com"',
      '[done] ┊ 💻 $         curl -s "https://example.com"  0.2s (0.3s)',
      "Done.",
    ].join("\n");
    expect(stripQueryEcho(stdout)).toBe(
      [
        '[tool] terminal: curl -s "https://example.com"',
        '[done] ┊ 💻 $         curl -s "https://example.com"  0.2s (0.3s)',
        "Done.",
      ].join("\n"),
    );
  });

  it("cuts a Rich-wrapped multi-line Query echo (no per-line marker of its own) up to the answer's streaming box", () => {
    // Rich's console.print word-wraps a long "Query: <entire prompt>" string
    // at the console width with plain continuation lines carrying no prefix
    // — this is what a real Paperclip agent prompt (agent instructions +
    // wake context + task markdown) looks like once echoed.
    const wrappedEcho = [
      "Query: You are \"agent-a\", an AI agent employee in a Paperclip-managed",
      "company. Paperclip runtime identity: - Agent ID: agent-a - Company ID:",
      "company-1 ... (many more wrapped lines of the full prompt)",
    ];
    const stdout = [...wrappedEcho, "╭─⚕ Hermes──────╮", "Done.", "╰──────╯"].join("\n");
    expect(stripQueryEcho(stdout)).toBe(["╭─⚕ Hermes──────╮", "Done.", "╰──────╯"].join("\n"));
  });

  it("recognizes the box.HORIZONTALS panel title as a boundary", () => {
    const panelStdout = ["Query: hi", "─ ⚕ Hermes ──────", "Done.", "─────────────────"].join("\n");
    expect(stripQueryEcho(panelStdout)).toBe(["─ ⚕ Hermes ──────", "Done.", "─────────────────"].join("\n"));
  });

  it("falls back to the validated exit summary as a boundary when no per-line marker (tool progress, answer frame) ever appears — a turn with no tool calls and, for whatever reason, no answer frame either", () => {
    const stdout = "Query: hi" + buildExitSummary("20260928_143022_ab12cd");
    expect(stripQueryEcho(stdout)).toBe(buildExitSummary("20260928_143022_ab12cd").replace(/^\n/, ""));
  });

  it("does NOT stop at a bare 'Resume this session with:' line inside the still-echoing prompt — keeps scanning to the real boundary", () => {
    // Regression for the critical false-positive: `isTurnOutputBoundaryLine` used to treat a
    // bare "Resume this session with:" line as a boundary on its own, so an echoed prompt that
    // happened to quote that exact sentence (e.g. documentation about Hermes sessions — this
    // PR's own subject matter) would end suppression right there, leaking the rest of the
    // still-echoing prompt into the transcript/log as if it were real turn output.
    const stdout = [
      "Query: See the docs below for how sessions work.",
      "Resume this session with:",
      "  hermes --resume <id> (this is prompt text, not real CLI output)",
      "That's the whole mechanism.",
      '[tool] terminal: curl -s "https://example.com"',
      "Done.",
    ].join("\n");
    expect(stripQueryEcho(stdout)).toBe(
      ['[tool] terminal: curl -s "https://example.com"', "Done."].join("\n"),
    );
  });

  it("is a no-op for quiet-mode stdout (no Query: line at all)", () => {
    const stdout = "Just the final response.\n\nsession_id: 20260928_143022_ab12cd\n";
    expect(stripQueryEcho(stdout)).toBe(stdout);
  });

  it("is a no-op when no recognized boundary follows the echo (e.g. killed before any turn output)", () => {
    // Senior review round 1: leaving the raw echo in place here used to be
    // the actual STORED RESPONSE for this shape too — parseHermesOutput's
    // legacy fallback ran a blanket `cleanResponse(stdout)` over exactly
    // this no-op output, so the whole prompt (agent instructions, wake
    // context, task markdown) reached Paperclip as if it were the agent's
    // answer. `stripQueryEcho` staying conservative here is still correct on
    // its own terms — this is genuinely a case where it cannot tell where
    // the echo ends without guessing — but the caller no longer trusts it
    // for that: `analyzeLiveTurn` (see below) finds no frame in this same
    // stdout and returns no answer, and `execute()`'s live-mode parsing takes
    // the response ONLY from a found frame, never from this raw fallback
    // text. See execute.myrmidon-live-progress.myrmidon.test.ts.
    const stdout = "Query: Fix the missing null check.\nstill just wrapped prompt text, nothing else ever printed";
    expect(stripQueryEcho(stdout)).toBe(stdout);
    expect(analyzeLiveTurn(stdout)).toEqual({ answer: undefined, failureMessage: undefined });
  });

  it("leaves leading blank lines before the Query: line untouched", () => {
    const stdout = ["", "Query: hi", "[tool] terminal: ls", "Done."].join("\n");
    expect(stripQueryEcho(stdout)).toBe(["", "[tool] terminal: ls", "Done."].join("\n"));
  });
});

describe("createLiveLogSanitizer", () => {
  it("buffers a trailing partial line and only redacts once it is complete", () => {
    const sanitizer = createLiveLogSanitizer();
    // Fake, two-halves-built secret value (see
    // shared/myrmidon-secret-redaction.myrmidon.test.ts for why), split mid-value
    // across two `data` events: the first chunk alone has no closing quote,
    // so it must not be forwarded yet.
    const secretValue = "correct horse" + " battery";
    const line = `password="${secretValue}"\n`;
    const splitAt = line.indexOf(secretValue) + 6; // mid-value, not a clean boundary
    expect(sanitizer.push("stdout", line.slice(0, splitAt))).toEqual([]);
    expect(sanitizer.push("stdout", line.slice(splitAt))).toEqual(['password="[REDACTED]"']);
  });

  it("drops the 'Query:' echo across several pushes, keeps the boundary line", () => {
    const sanitizer = createLiveLogSanitizer();
    expect(sanitizer.push("stdout", "Query: entire prompt\n")).toEqual([]);
    expect(sanitizer.push("stdout", "wrapped continuation, no marker\n")).toEqual([]);
    expect(sanitizer.push("stdout", "still wrapped\n")).toEqual([]);
    expect(sanitizer.push("stdout", '[tool] terminal: curl -s "https://example.com"\n')).toEqual([
      '[tool] terminal: curl -s "https://example.com"',
    ]);
    // Suppression is over: ordinary output after the boundary passes through.
    expect(sanitizer.push("stdout", "Done.\n")).toEqual(["Done."]);
  });

  it("only suppresses the Query: echo on stdout, never on stderr", () => {
    const sanitizer = createLiveLogSanitizer();
    expect(sanitizer.push("stdout", "Query: entire prompt\n")).toEqual([]);
    // A benign stderr line arriving mid-echo must still pass through — the
    // suppression state is stdout-only, matching where the vendor CLI
    // actually prints the echo.
    expect(sanitizer.push("stderr", "some MCP init noise\n")).toEqual(["some MCP init noise"]);
  });

  it("flush() drops a still-buffered partial line if the echo boundary never arrived", () => {
    const sanitizer = createLiveLogSanitizer();
    sanitizer.push("stdout", "Query: entire prompt\n");
    sanitizer.push("stdout", "wrapped continuation with no trailing newline (run killed here)");
    expect(sanitizer.flush()).toEqual([]);
  });

  it("flush() redacts and forwards an ordinary trailing partial line with no newline", () => {
    const sanitizer = createLiveLogSanitizer();
    sanitizer.push("stdout", "Done, verified with a targeted run.");
    expect(sanitizer.flush()).toEqual([
      { stream: "stdout", line: "Done, verified with a targeted run." },
    ]);
  });
});

/** See shared/myrmidon-panel-frame.ts for the verified `box.HORIZONTALS` layout. */
function buildPanelBlock(title: string, bodyLines: string[], width = 80): string {
  const inner = width - 2;
  const titleSegment = `─ ${title} `;
  const top = ` ${titleSegment}${"─".repeat(Math.max(inner - titleSegment.length, 0))} `;
  const bottom = ` ${"─".repeat(inner)} `;
  const blank = ` ${" ".repeat(inner)} `;
  const row = (text: string) => ` ${text.padEnd(inner, " ")} `;
  return [top, blank, ...bodyLines.map(row), blank, bottom].join("\r\n");
}

/** The default (`display.streaming: true`) successful-turn shape — see shared/myrmidon-panel-frame.ts. */
function buildStreamBox(label: string, bodyLines: string[], width = 80): string {
  const fill = width - 2 - label.length;
  const header = `╭─${label}${"─".repeat(Math.max(fill - 1, 0))}╮`;
  const footer = `╰${"─".repeat(width - 2)}╯`;
  return ["", header, ...bodyLines, footer].join("\n");
}

const DIVIDER = "─".repeat(40);

/** The stdout `execute()` hands to `analyzeLiveTurn`: exit summary already cut off. */
function turnOf(capture: string) {
  return analyzeLiveTurn(stripExitSummary(capture));
}

describe("analyzeLiveTurn — real CLI output", () => {
  it("takes only the last box of a multi-tool success as the answer (divider, intermediate boxes, tool lines and the write_file diff are all outside it)", () => {
    const turn = turnOf(REAL_MULTI_TOOL_SUCCESS);
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.kind).toBe("stream");
    expect(turn.answer?.bodyLines.join("\n").replace(/\r/g, "")).toBe(
      "Fixed the missing null check in the session lookup.\n\n- Verified with a targeted run\n- Updated the changelog entry",
    );
  });

  it("takes the single box of a tool-less success", () => {
    const turn = turnOf(REAL_SIMPLE_SUCCESS);
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.bodyLines.join("\n")).toContain("Fixed the missing null check");
  });

  it("flags an HTTP 400 turn as failed although the Panel body does not start with 'Error:'", () => {
    const turn = turnOf(REAL_FAILED_400);
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("HTTP 400: Invalid request: unsupported parameter");
    // The reviewer's original criterion (Panel body starts with "Error:")
    // does not describe what the CLI really prints for a provider error.
    expect(turn.failureMessage).not.toMatch(/^Error:/);
  });

  it("flags exhausted credits as failed and reports the refusal, not the call-to-action Panel", () => {
    const turn = turnOf(REAL_FAILED_402_WITH_CALL_TO_ACTION);
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toMatch(/^Billing or credits exhausted: HTTP 402/);
    expect(turn.failureMessage).not.toContain("Add credits with Custom.");
  });

  it("flags a rate limit that survived all retries", () => {
    const turn = turnOf(REAL_FAILED_429_AFTER_RETRIES);
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("API call failed after 3 retries: HTTP 429: Rate limit reached for requests");
  });

  it("flags a server error that survived all retries", () => {
    const turn = turnOf(REAL_FAILED_500_AFTER_RETRIES);
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toContain("API call failed after 3 retries: HTTP 500");
  });

  it("finds no answer and no verdict when the CLI exited before any turn (no frame at all)", () => {
    for (const capture of [REAL_EARLY_EXIT_NO_CREDENTIALS, REAL_EARLY_EXIT_SESSION_NOT_FOUND, "Goodbye! ⚕\n", ""]) {
      expect(turnOf(capture)).toEqual({ answer: undefined, failureMessage: undefined });
    }
  });
});

describe("analyzeLiveTurn — failure signals in isolation", () => {
  const panel = (title: string, body: string[]) => buildPanelBlock(title, body);

  it("Panel body starting with 'Error:' (the empty-response fallback) is a failure", () => {
    const turn = analyzeLiveTurn(panel("⚕ Hermes", ["Error: the model returned an empty response."]));
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("Error: the model returned an empty response.");
  });

  it("a streaming-box answer is never a failure by its text, even when it starts with 'Error:'", () => {
    const turn = analyzeLiveTurn(buildStreamBox("⚕ Hermes", ["Error: this is just prose in a real answer."]));
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.bodyLines).toEqual(["Error: this is just prose in a real answer."]);
  });

  it("a Panel answer with no failure marker is accepted (what a success looks like with display.streaming off)", () => {
    const turn = analyzeLiveTurn([DIVIDER, "  ┊ 💻 $ ls  0.1s", panel("⚕ Hermes", ["All fixed."])].join("\n"));
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.bodyLines.map((l) => l.trim()).filter(Boolean)).toEqual(["All fixed."]);
  });

  it("the 'Out of credits' Panel alone is a failure, worded from its own body", () => {
    const turn = analyzeLiveTurn(panel("⚡ Out of credits", ["Add credits with the provider."]));
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("Add credits with the provider.");
  });

  it("the 'Out of credits' Panel is a failure even after a streaming-box answer, and is never picked as the answer", () => {
    const turn = analyzeLiveTurn(
      [buildStreamBox("⚕ Hermes", ["Partial progress."]), panel("⚡ Out of credits", ["Add credits."])].join("\n"),
    );
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("Add credits.");
  });

  it("a turn-loop cross-mark line right before the Panel, after the turn divider, is a failure", () => {
    const turn = analyzeLiveTurn(
      [DIVIDER, "", "❌ Non-retryable client error (HTTP 400). Aborting.\r", panel("⚕ Hermes", ["HTTP 400: bad request"])].join("\n"),
    );
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("HTTP 400: bad request");
  });

  it("a cross-mark line after an earlier streamed box (no divider in between) is a failure", () => {
    const turn = analyzeLiveTurn(
      [
        buildStreamBox("⚕ Hermes", ["Partial progress."]),
        "❌ Max retries (3) for invalid tool calls exceeded. Stopping as partial.",
        panel("⚕ Hermes", ["Stopped after repeated invalid tool calls."]),
      ].join("\n"),
    );
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("Stopped after repeated invalid tool calls.");
  });

  it("a cross-mark line inside the echoed prompt (before the divider) is not evidence", () => {
    const turn = analyzeLiveTurn(
      [
        "Query: Review this checklist:",
        "❌ item one is not done",
        "Initializing agent...",
        DIVIDER,
        panel("⚕ Hermes", ["All fixed."]),
      ].join("\n"),
    );
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer).toBeDefined();
  });

  it("claims nothing from a cross-mark line when there is neither a divider nor an earlier frame to bound the turn", () => {
    const turn = analyzeLiveTurn(["❌ looks like narration", panel("⚕ Hermes", ["All fixed."])].join("\n"));
    expect(turn.failureMessage).toBeUndefined();
  });

  it("an indented cross mark (tool output, a diff context row) is not turn-loop narration", () => {
    const turn = analyzeLiveTurn(
      [DIVIDER, "  ┊ review diff", " ❌ still failing in the old docs", panel("⚕ Hermes", ["All fixed."])].join("\n"),
    );
    expect(turn.failureMessage).toBeUndefined();
  });

  it("a recovered provider error (retry narration, then a normal streaming-box answer) stays a success", () => {
    const turn = analyzeLiveTurn(
      [
        DIVIDER,
        "⚠️  API call failed (attempt 1/3): APIStatusError [HTTP 500]",
        "⏳ Retrying in 2.6s (attempt 1/3)...",
        buildStreamBox("⚕ Hermes", ["Done after one retry."]),
      ].join("\n"),
    );
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.bodyLines).toEqual(["Done after one retry."]);
  });

  it("bounds the failure message and falls back to a generic one for an empty body", () => {
    const long = analyzeLiveTurn(panel("⚕ Hermes", ["Error: " + "x".repeat(5000)]));
    expect(long.failureMessage!.length).toBeLessThanOrEqual(1000);
    const empty = analyzeLiveTurn(panel("⚡ Out of credits", []));
    expect(empty.failureMessage).toMatch(/failed turn/);
  });

  it("ignores an unterminated trailing frame (killed mid-answer): the last COMPLETE frame is still the answer", () => {
    const complete = buildStreamBox("⚕ Hermes", ["Fixed the missing null check."]);
    const truncated = buildStreamBox("⚕ Hermes", ["Still working"]).split("\n").slice(0, 3).join("\n");
    const turn = analyzeLiveTurn([complete, truncated].join("\n"));
    expect(turn.answer?.bodyLines).toEqual(["Fixed the missing null check."]);
  });
});
