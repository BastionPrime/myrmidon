import { describe, expect, it } from "vitest";

import {
  createLiveLogSanitizer,
  extractLiveAnswerFrame,
  extractLiveSessionId,
  LIVE_PROGRESS_ENV_VAR,
  LIVE_SESSION_ID_REGEX,
  liveModeErrorFromFrame,
  QUIET_SESSION_ID_REGEX,
  resolveHermesQuietMode,
  stripExitSummary,
  stripQueryEcho,
} from "./myrmidon-live-progress.js";

describe("resolveHermesQuietMode", () => {
  it("ignores adapterConfig.quiet=true when the env flag is unset (default on)", () => {
    expect(resolveHermesQuietMode(true, {})).toBe(false);
  });

  it("ignores adapterConfig.quiet=true when the env flag is any truthy-ish value", () => {
    for (const v of ["1", "true", "yes", "on", "banana", "  "]) {
      expect(resolveHermesQuietMode(true, { [LIVE_PROGRESS_ENV_VAR]: v })).toBe(false);
    }
  });

  it("also forces non-quiet when the card left quiet unset (unaffected either way)", () => {
    expect(resolveHermesQuietMode(false, {})).toBe(false);
  });

  it("falls back to the card's own quiet setting when explicitly disabled", () => {
    for (const v of ["0", "false", "No", "OFF"]) {
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
    // for that: `extractLiveAnswerFrame` (see below) finds no frame in this
    // same stdout and returns undefined, and `execute()`'s live-mode parsing
    // takes the response ONLY from a found frame, never from this raw
    // fallback text. See execute.myrmidon-live-progress.myrmidon.test.ts's
    // "flags an early-exit failure … and never leaks the raw prompt echo".
    const stdout = "Query: Fix the missing null check.\nstill just wrapped prompt text, nothing else ever printed";
    expect(stripQueryEcho(stdout)).toBe(stdout);
    expect(extractLiveAnswerFrame(stdout)).toBeUndefined();
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

describe("extractLiveAnswerFrame", () => {
  it("returns undefined for stdout with no frame at all (early exit before any turn ran)", () => {
    expect(extractLiveAnswerFrame("Goodbye! ⚕\n")).toBeUndefined();
    expect(extractLiveAnswerFrame("Session not found.\n")).toBeUndefined();
    expect(extractLiveAnswerFrame("")).toBeUndefined();
  });

  it("returns the single frame when there is exactly one", () => {
    const stdout = buildStreamBox("⚕ Hermes", ["All fixed. See the PR."]);
    const frame = extractLiveAnswerFrame(stdout);
    expect(frame?.kind).toBe("stream");
    expect(frame?.bodyLines).toEqual(["All fixed. See the PR."]);
  });

  it("takes the LAST frame, dropping the turn divider, earlier streamed commentary, and inline tool diffs between them", () => {
    // A realistic multi-tool-call turn: the divider cli_chat_turn_mixin.py
    // prints at the start of every turn, an intermediate streamed comment
    // before a tool call, the tool's own diff output (top-level, no frame
    // border), then the box that reopens for the real final answer.
    const stdout = [
      "─".repeat(40),
      buildStreamBox("⚕ Hermes", ["Let me check the session lookup first."]),
      '[tool] terminal: git diff',
      "  ┊ review diff",
      "  ┊ - if (session) {",
      "  ┊ + if (session && session.isValid) {",
      buildStreamBox("⚕ Hermes", ["Fixed. All tests pass."]),
    ].join("\n");
    const frame = extractLiveAnswerFrame(stdout);
    expect(frame?.bodyLines).toEqual(["Fixed. All tests pass."]);
  });

  it("takes the last Panel when a failed/partial turn follows an already-streamed box (mixed shapes in one run)", () => {
    const stdout = [
      buildStreamBox("⚕ Hermes", ["Partial progress before the error."]),
      buildPanelBlock("⚕ Hermes", ["Error: the provider returned a rate-limit response."]),
    ].join("\n");
    const frame = extractLiveAnswerFrame(stdout);
    expect(frame?.kind).toBe("panel");
    expect(frame?.bodyLines.join("\n")).toContain("Error: the provider returned a rate-limit response.");
  });

  it("ignores an unterminated trailing frame (killed mid-answer) the same way stripRichPanelFrames does", () => {
    const complete = buildStreamBox("⚕ Hermes", ["Fixed the missing null check."]);
    const truncated = buildStreamBox("⚕ Hermes", ["Still working"]).split("\n").slice(0, 3).join("\n");
    const stdout = [complete, truncated].join("\n");
    // The complete, earlier frame is still found — an unterminated later one
    // just isn't counted, it doesn't hide the last COMPLETE frame silently
    // returning the wrong (earlier) one would be worse than finding none.
    const frame = extractLiveAnswerFrame(stdout);
    expect(frame?.bodyLines).toEqual(["Fixed the missing null check."]);
  });
});

describe("liveModeErrorFromFrame", () => {
  it("is undefined for a streaming-box frame regardless of content (never the error shape)", () => {
    const frame = extractLiveAnswerFrame(buildStreamBox("⚕ Hermes", ["Error: this is just prose in a real answer."]));
    expect(liveModeErrorFromFrame(frame)).toBeUndefined();
  });

  it("is undefined for a Panel frame whose body does not start with 'Error:'", () => {
    const frame = extractLiveAnswerFrame(buildPanelBlock("⚕ Hermes", ["All fixed. See the PR."]));
    expect(liveModeErrorFromFrame(frame)).toBeUndefined();
  });

  it("returns the message for a Panel frame whose body starts with 'Error:' (provider/billing failure mid-turn)", () => {
    const frame = extractLiveAnswerFrame(
      buildPanelBlock("⚕ Hermes", ["Error: insufficient credits. Add credits with your provider."]),
    );
    expect(liveModeErrorFromFrame(frame)).toBe("Error: insufficient credits. Add credits with your provider.");
  });

  it("is undefined when there is no frame at all", () => {
    expect(liveModeErrorFromFrame(undefined)).toBeUndefined();
  });
});
