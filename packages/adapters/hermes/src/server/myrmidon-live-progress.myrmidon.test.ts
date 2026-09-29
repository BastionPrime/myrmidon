import { describe, expect, it } from "vitest";

import {
  analyzeLiveRun,
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
import { splitQueryEcho } from "./myrmidon-query-echo.js";
import { richEcho } from "./myrmidon-query-echo.fixtures.js";
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

/** The prompt behind every `Query:` line in the captured fixtures. */
const FIXTURE_PROMPT = "Fix the null check in session.ts and report.";

/** What the CLI printed after its `Query:` line in a fixture (everything but the echo). */
function afterEchoOf(capture: string): string {
  return capture.slice(capture.indexOf("\n") + 1);
}

/** A capture as it would look for `prompt`: the echo of that prompt, then the fixture's own output. */
function withEcho(prompt: string, capture: string): string {
  return richEcho(prompt) + afterEchoOf(capture);
}

/** A realistic multi-paragraph agent prompt (neutral names), with a tab and indentation the echo re-flows. */
const AGENT_PROMPT = [
  'You are "agent-a", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: agent-a",
  "- Company ID: company-1",
  "",
  "## Task",
  "Fix the null check in session.ts, then report what changed. Keep the change small and explain every decision you take along the way.",
  "",
  "\tIndented with a tab: keep going after the first failure.",
].join("\n");

const REAL_AFTER_ECHO = afterEchoOf(REAL_SIMPLE_SUCCESS);

describe("stripQueryEcho", () => {
  it("cuts a one-line echo and keeps everything the CLI printed after it", () => {
    const stdout = richEcho(FIXTURE_PROMPT) + REAL_AFTER_ECHO;
    expect(stripQueryEcho(stdout, FIXTURE_PROMPT)).toBe(REAL_AFTER_ECHO);
  });

  it("cuts a Rich-wrapped multi-paragraph echo exactly (wrap points, tabs and blank lines change only whitespace)", () => {
    const echo = richEcho(AGENT_PROMPT);
    expect(echo.split("\n").length).toBeGreaterThan(8);
    expect(stripQueryEcho(echo + REAL_AFTER_ECHO, AGENT_PROMPT)).toBe(REAL_AFTER_ECHO);
  });

  it("does not let a lone frame-top line inside the echo through (it used to end the echo early)", () => {
    const prompt = ["Notes from the last run:", "╭─ ⚕ Hermes ────────────────────╮", "The answer was 42.", "Continue from there."].join("\n");
    const stripped = stripQueryEcho(richEcho(prompt) + REAL_AFTER_ECHO, prompt);
    expect(stripped).toBe(REAL_AFTER_ECHO);
    expect(stripped).not.toContain("The answer was 42");
    expect(stripped).not.toContain("Continue from there");
  });

  it("does not let tool-progress lines or rules inside the echo through", () => {
    const prompt = [
      "The previous run looked like this:",
      "  ┊ 💻 $         cat /workspace/session.ts  0.1s",
      "────────────────────────────────────────",
      "  ┊ ✍️  write     /workspace/session.ts  1.3s",
      "Do the same again.",
    ].join("\n");
    const stripped = stripQueryEcho(richEcho(prompt) + REAL_AFTER_ECHO, prompt);
    expect(stripped).toBe(REAL_AFTER_ECHO);
  });

  it("does not let a quoted whole hermes run (frame, exit summary) inside the echo through", () => {
    const quoted = REAL_MULTI_TOOL_SUCCESS.replace(/\r/g, "");
    const prompt = `The previous run printed:\n${quoted}\nPlease compare it with this one.`;
    const stripped = stripQueryEcho(richEcho(prompt) + REAL_AFTER_ECHO, prompt);
    expect(stripped).toBe(REAL_AFTER_ECHO);
    expect(extractLiveSessionId(stripped)).toBe("20260101_120000_a1b2c3");
  });

  it("keeps what precedes the Query: line", () => {
    const stdout = "warming up\n" + richEcho(FIXTURE_PROMPT) + REAL_AFTER_ECHO;
    expect(stripQueryEcho(stdout, FIXTURE_PROMPT)).toBe("warming up\n" + REAL_AFTER_ECHO);
  });

  it("is a no-op for quiet-mode stdout (no Query: line at all)", () => {
    const stdout = "Just the final response.\n\nsession_id: 20260928_143022_ab12cd\n";
    expect(stripQueryEcho(stdout, FIXTURE_PROMPT)).toBe(stdout);
  });

  it("fails closed: when the text after `Query:` is not the prompt, nothing after it is returned", () => {
    const stdout = "Query: something the CLI rewrote entirely, not what was sent\n" + REAL_AFTER_ECHO;
    expect(stripQueryEcho(stdout, FIXTURE_PROMPT)).toBe("");
  });

  it("fails closed: a run killed while echoing returns nothing of the echo", () => {
    const echo = richEcho(AGENT_PROMPT);
    const stdout = echo.slice(0, Math.floor(echo.length / 2));
    expect(stripQueryEcho(stdout, AGENT_PROMPT)).toBe("");
  });

  it("does not stop at a `Query:` line the prompt itself contains", () => {
    const prompt = "Line one of the task.\nQuery: a line that only looks like the echo's own\nLine three of the task.";
    expect(stripQueryEcho(richEcho(prompt) + REAL_AFTER_ECHO, prompt)).toBe(REAL_AFTER_ECHO);
  });
});

describe("exit summary — the last thing in the output", () => {
  const AFTER = buildExitSummary("20260928_143022_ab12cd");

  it("takes the real summary when the answer quotes a whole earlier summary before it", () => {
    const quoted = buildExitSummary("20200101_000000_quoted").replace(/^\n/, "");
    const stdout = ["The last run ended like this:", quoted, "", "And the new one follows."].join("\n") + AFTER;
    expect(extractLiveSessionId(stdout)).toBe("20260928_143022_ab12cd");
    // Only the real summary is cut; the quoted one stays where the model wrote it.
    expect(stripExitSummary(stdout).endsWith("And the new one follows.\n")).toBe(true);
    expect(stripExitSummary(stdout)).toContain("20200101_000000_quoted");
  });

  it("does not take a whole quoted summary that something follows (nothing real ended the run)", () => {
    const stdout = buildExitSummary("20200101_000000_quoted") + "\nand then the run was killed while it was still printing\n";
    expect(extractLiveSessionId(stdout)).toBeUndefined();
    expect(stripExitSummary(stdout)).toBe(stdout);
  });

  it("accepts the optional resume-by-title hint, a Title field and a trailing newline", () => {
    const stdout = ["Done.", "", "Resume this session with:", "  hermes --resume 20260101_120000_a1b2c3", '  hermes -c "Mock title"', "", "Session:        20260101_120000_a1b2c3", "Title:          Mock title", "Duration:       10s", "Messages:       1 (1 user, 0 tool calls)", ""].join("\n");
    expect(extractLiveSessionId(stdout)).toBe("20260101_120000_a1b2c3");
    expect(stripExitSummary(stdout)).toBe("Done.\n\n");
  });

  it("accepts CRLF line endings", () => {
    const stdout = "Done.\r\n" + buildExitSummary("20260928_143022_ab12cd").replace(/\n/g, "\r\n") + "\r\n";
    expect(extractLiveSessionId(stdout)).toBe("20260928_143022_ab12cd");
  });

  it("does not recognize a summary that the vendor extended with a line that is not a field", () => {
    const stdout = "Done." + AFTER + "\nSee you next time!\n";
    expect(extractLiveSessionId(stdout)).toBeUndefined();
  });
});

describe("createLiveLogSanitizer", () => {
  /** Push `text` in chunks of `size` characters, then flush; the lines forwarded, in order. */
  function run(prompt: string, text: string, size = text.length): string[] {
    const sanitizer = createLiveLogSanitizer(prompt);
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...sanitizer.push("stdout", text.slice(i, i + size)));
    out.push(...sanitizer.flush().map((f) => f.line));
    return out;
  }
  const lines = (text: string) => text.replace(/\r/g, "").replace(/\n$/, "").split("\n");

  it("buffers a trailing partial line and only redacts once it is complete", () => {
    const sanitizer = createLiveLogSanitizer(FIXTURE_PROMPT);
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

  it("drops the echo across several pushes and forwards everything the CLI printed after it", () => {
    const sanitizer = createLiveLogSanitizer(AGENT_PROMPT);
    const echoLines = richEcho(AGENT_PROMPT).split("\n").slice(0, -1);
    for (const line of echoLines) expect(sanitizer.push("stdout", line + "\n")).toEqual([]);
    expect(sanitizer.push("stdout", "Initializing agent...\r\n")).toEqual(["Initializing agent..."]);
    expect(sanitizer.push("stdout", `${DIVIDER}\r\n`)).toEqual([DIVIDER]);
  });

  it("forwards the vendor's own message that ends an early exit (it used to be dropped with the echo)", () => {
    const out = run(FIXTURE_PROMPT, richEcho(FIXTURE_PROMPT) + afterEchoOf(REAL_EARLY_EXIT_SESSION_NOT_FOUND));
    expect(out).toContain("Session not found: 20200101_000000_nosuch");
    expect(out).toContain("Use a session ID from a previous CLI run (hermes sessions list).");
    expect(out.join("\n")).not.toContain("Query:");
  });

  it("drops an echo that holds frames, tool lines, rules and a quoted whole run, then forwards the real output", () => {
    const quoted = REAL_MULTI_TOOL_SUCCESS.replace(/\r/g, "");
    const prompt = `Earlier:\n╭─ ⚕ Hermes ─────────────╮\n  ┊ 💻 $ ls  0.1s\n${DIVIDER}\n${quoted}\nCompare.`;
    const out = run(prompt, richEcho(prompt) + REAL_AFTER_ECHO);
    expect(out).toEqual(lines(REAL_AFTER_ECHO));
  });

  it("gives the same result however the stream is chunked", () => {
    const text = richEcho(AGENT_PROMPT) + REAL_AFTER_ECHO;
    const whole = run(AGENT_PROMPT, text);
    for (const size of [1, 3, 17, 64]) expect(run(AGENT_PROMPT, text, size)).toEqual(whole);
    expect(whole).toEqual(lines(REAL_AFTER_ECHO));
  });

  it("does not drop a later `Query:` line of the real output", () => {
    const text = richEcho(FIXTURE_PROMPT) + "Initializing agent...\nQuery: printed by a tool, not an echo\n";
    expect(run(FIXTURE_PROMPT, text)).toEqual(["Initializing agent...", "Query: printed by a tool, not an echo"]);
  });

  it("redacts what it forwards after the echo", () => {
    const secretValue = "correct horse" + " battery";
    const out = run(FIXTURE_PROMPT, richEcho(FIXTURE_PROMPT) + `password="${secretValue}"\n`);
    expect(out).toEqual(['password="[REDACTED]"']);
  });

  it("keeps a secret pasted into the prompt out of the log (the echo is dropped whole)", () => {
    const secretValue = "correct horse" + " battery";
    const prompt = `Deploy notes: the admin login uses ${secretValue} as its phrase, do not share it.`;
    const out = run(prompt, richEcho(prompt) + REAL_AFTER_ECHO);
    expect(out.join("\n")).not.toContain("correct horse");
  });

  it("falls back to the boundary heuristic when the text after `Query:` is not the prompt (nothing after it is trusted)", () => {
    const out = run(FIXTURE_PROMPT, "Query: rewritten by the CLI\nwrapped rest of it\n" + REAL_AFTER_ECHO);
    expect(out).not.toContain("wrapped rest of it");
    expect(out.join("\n")).toContain("Fixed the missing null check");
  });

  it("only suppresses the Query: echo on stdout, never on stderr", () => {
    const sanitizer = createLiveLogSanitizer(AGENT_PROMPT);
    expect(sanitizer.push("stdout", "Query: You are \"agent-a\", an AI agent\n")).toEqual([]);
    // A benign stderr line arriving mid-echo must still pass through — the
    // suppression state is stdout-only, matching where the vendor CLI
    // actually prints the echo.
    expect(sanitizer.push("stderr", "some MCP init noise\n")).toEqual(["some MCP init noise"]);
  });

  it("flush() drops a still-buffered partial line if the echo never ended", () => {
    const sanitizer = createLiveLogSanitizer(AGENT_PROMPT);
    sanitizer.push("stdout", "Query: You are \"agent-a\", an AI agent employee\n");
    sanitizer.push("stdout", "in a Paperclip-managed company. Paperclip runtime identity: - Age");
    expect(sanitizer.flush()).toEqual([]);
  });

  it("flush() redacts and forwards an ordinary trailing partial line with no newline", () => {
    const sanitizer = createLiveLogSanitizer(FIXTURE_PROMPT);
    sanitizer.push("stdout", "Done, verified with a targeted run.");
    expect(sanitizer.flush()).toEqual([
      { stream: "stdout", line: "Done, verified with a targeted run." },
    ]);
  });

  it("with an empty prompt there is nothing to hide: every line is forwarded", () => {
    expect(run("", "Query: whatever\nnext\n")).toEqual(["Query: whatever", "next"]);
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

/** The text `analyzeLiveRun` hands to `analyzeLiveTurn` for a fixture: echo and exit summary already cut off. */
function turnOf(capture: string) {
  return analyzeLiveTurn(stripExitSummary(splitQueryEcho(capture, FIXTURE_PROMPT).after));
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

  it("finds neither an answer nor a verdict in text with no frame at all (what that means is `analyzeLiveRun`'s call, below)", () => {
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

  it("a cross-mark line before the turn divider is not evidence about the turn (it stops the scan)", () => {
    const turn = analyzeLiveTurn(
      ["❌ startup narration of an earlier attempt", DIVIDER, panel("⚕ Hermes", ["All fixed."])].join("\n"),
    );
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer).toBeDefined();
  });

  it("a cross-mark line right before the Panel is a failure even with no divider and no earlier frame (the text is after the echo, so it is the CLI's own)", () => {
    const turn = analyzeLiveTurn(["❌ Non-retryable client error (HTTP 400). Aborting.", panel("⚕ Hermes", ["HTTP 400: bad request"])].join("\n"));
    expect(turn.answer).toBeUndefined();
    expect(turn.failureMessage).toBe("HTTP 400: bad request");
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

describe("analyzeLiveRun — real CLI output, clean exit", () => {
  const clean = { timedOut: false, exitCode: 0 } as const;
  const run = (capture: string, prompt = FIXTURE_PROMPT) => analyzeLiveRun(capture, prompt, clean);

  it("takes the answer and the session id from a success, with no error", () => {
    for (const capture of [REAL_MULTI_TOOL_SUCCESS, REAL_SIMPLE_SUCCESS]) {
      const result = run(capture);
      expect(result.errorMessage).toBeUndefined();
      expect(result.answer).toBeDefined();
      expect(result.sessionId).toBe("20260101_120000_a1b2c3");
      expect(result.echo).toBe("aligned");
      expect(result.staleSession).toBe(false);
    }
  });

  it("records each failed turn as a failure with an empty answer and still reads the session id", () => {
    for (const capture of [
      REAL_FAILED_400,
      REAL_FAILED_402_WITH_CALL_TO_ACTION,
      REAL_FAILED_429_AFTER_RETRIES,
      REAL_FAILED_500_AFTER_RETRIES,
    ]) {
      const result = run(capture);
      expect(result.answer).toBeUndefined();
      expect(result.errorMessage).toBeDefined();
      expect(result.sessionId).toBeDefined();
    }
  });

  it("returns the output minus the echo as the visible stdout", () => {
    expect(run(REAL_SIMPLE_SUCCESS).visibleStdout).toBe(afterEchoOf(REAL_SIMPLE_SUCCESS));
  });

  it("an early exit for missing credentials is a failure whose message carries the vendor's own text", () => {
    const result = run(REAL_EARLY_EXIT_NO_CREDENTIALS);
    expect(result.sessionId).toBeUndefined();
    expect(result.errorMessage).toContain("without printing an exit summary");
    expect(result.errorMessage).toContain("No API key found for provider 'openrouter'");
    expect(result.errorMessage).not.toContain("Goodbye");
    expect(result.staleSession).toBe(false);
  });

  it("an early exit for a missing --resume target is a failure with the vendor text, and marks the stored session stale", () => {
    const result = run(REAL_EARLY_EXIT_SESSION_NOT_FOUND);
    expect(result.errorMessage).toContain("Session not found: 20200101_000000_nosuch");
    expect(result.errorMessage).not.toContain("Initializing agent");
    expect(result.staleSession).toBe(true);
  });

  it("marks the stored session stale for `Cannot resume session:` too", () => {
    const capture = withEcho(FIXTURE_PROMPT, "Query: x\nInitializing agent...\r\nCannot resume session: the session store is unreadable\r\n\nGoodbye! ⚕\n");
    const result = run(capture);
    expect(result.staleSession).toBe(true);
    expect(result.errorMessage).toContain("Cannot resume session: the session store is unreadable");
  });

  it("does not mark the session stale for a stale-session-looking line that only the model wrote", () => {
    const capture = REAL_MULTI_TOOL_SUCCESS.replace("Fixed the missing null check", "Session not found: x is what the CLI said earlier. Fixed the missing null check");
    const result = run(capture);
    expect(result.errorMessage).toBeUndefined();
    expect(result.staleSession).toBe(false);
  });

  it("a resumed session that failed to initialize, with a full exit summary and no frame, is a failure (it used to be an empty success)", () => {
    const capture = [
      richEcho(FIXTURE_PROMPT).trimEnd(),
      "Initializing agent...\r",
      "❌ Failed to initialize agent: provider 'custom' is not configured\r",
      "",
      "Resume this session with:",
      "  hermes --resume 20260101_120000_a1b2c3",
      "",
      "Session:        20260101_120000_a1b2c3",
      "Duration:       2s",
      "Messages:       0 (0 user, 0 tool calls)",
      "",
    ].join("\n");
    const result = run(capture);
    expect(result.answer).toBeUndefined();
    expect(result.sessionId).toBe("20260101_120000_a1b2c3");
    expect(result.errorMessage).toContain("without printing an answer");
    expect(result.errorMessage).toContain("Failed to initialize agent: provider 'custom' is not configured");
  });

  it("an exit summary with nothing else before it (an exception in chat(), an @-context block) is a failure too", () => {
    const capture = richEcho(FIXTURE_PROMPT) + "Initializing agent...\r\n\n" + buildExitSummary("20260101_120000_a1b2c3").replace(/^\n/, "") + "\n";
    const result = run(capture);
    expect(result.answer).toBeUndefined();
    expect(result.errorMessage).toContain("without printing an answer");
    expect(result.errorMessage).toContain("It printed nothing else.");
  });

  it("quotes only the first meaningful lines, bounded and redacted", () => {
    const secretValue = "correct horse" + " battery";
    const noise = Array.from({ length: 12 }, (_, i) => `vendor line ${i} ` + "y".repeat(200));
    const capture = richEcho(FIXTURE_PROMPT) + ["Initializing agent...", `password="${secretValue}"`, ...noise].join("\n") + buildExitSummary("20260101_120000_a1b2c3") + "\n";
    const result = run(capture);
    expect(result.errorMessage!.length).toBeLessThan(900);
    expect(result.errorMessage).not.toContain("correct horse");
    expect(result.errorMessage).toContain("[REDACTED]");
    expect(result.errorMessage).not.toContain("vendor line 11");
  });

  it("does not add a verdict when the run did not exit cleanly (execute() reports those itself)", () => {
    for (const end of [{ timedOut: true, exitCode: null }, { timedOut: false, exitCode: 1 }] as const) {
      expect(analyzeLiveRun(REAL_EARLY_EXIT_NO_CREDENTIALS, FIXTURE_PROMPT, end).errorMessage).toBeUndefined();
      const noFrame = richEcho(FIXTURE_PROMPT) + "Initializing agent...\r\n\n" + buildExitSummary("20260101_120000_a1b2c3").replace(/^\n/, "") + "\n";
      const result = analyzeLiveRun(noFrame, FIXTURE_PROMPT, end);
      expect(result.errorMessage).toBeUndefined();
      expect(result.sessionId).toBe("20260101_120000_a1b2c3");
    }
  });

  it("a summary the vendor extended with another line is not recognized: a clean exit fails with the vendor text, and no session id is taken", () => {
    const capture = REAL_SIMPLE_SUCCESS + "See you next time!\n";
    const result = run(capture);
    expect(result.sessionId).toBeUndefined();
    expect(result.errorMessage).toContain("without printing an exit summary");
  });
});

describe("analyzeLiveRun — the prompt echo cannot pass for output", () => {
  const clean = { timedOut: false, exitCode: 0 } as const;

  it("a prompt quoting a whole successful run does not turn a failed run into a success", () => {
    const quoted = REAL_MULTI_TOOL_SUCCESS.replace(/\r/g, "");
    const prompt = `The previous run printed:\n${quoted}\nDo it again.`;
    const capture = withEcho(prompt, REAL_FAILED_429_AFTER_RETRIES);
    const result = analyzeLiveRun(capture, prompt, clean);
    expect(result.answer).toBeUndefined();
    expect(result.errorMessage).toBe("API call failed after 3 retries: HTTP 429: Rate limit reached for requests");
    expect(result.visibleStdout).toBe(afterEchoOf(REAL_FAILED_429_AFTER_RETRIES));
  });

  it("a prompt quoting a whole run with its exit summary gives no session id and no answer to a run that stopped early", () => {
    const quoted = REAL_MULTI_TOOL_SUCCESS.replace(/\r/g, "");
    const prompt = `The previous run printed:\n${quoted}\nDo it again.`;
    const result = analyzeLiveRun(withEcho(prompt, REAL_EARLY_EXIT_NO_CREDENTIALS), prompt, clean);
    expect(result.sessionId).toBeUndefined();
    expect(result.answer).toBeUndefined();
    expect(result.errorMessage).toContain("No API key found");
  });

  it("a prompt with a lone frame-top line takes the real answer, not what the prompt says", () => {
    const prompt = ["Notes:", "╭─ ⚕ Hermes ────────────────────╮", "The answer was 42.", "╰──────────────────────────────╯", "Continue."].join("\n");
    const result = analyzeLiveRun(withEcho(prompt, REAL_SIMPLE_SUCCESS), prompt, clean);
    expect(result.errorMessage).toBeUndefined();
    expect(result.answer?.bodyLines.join("\n")).toContain("Fixed the missing null check");
    expect(result.answer?.bodyLines.join("\n")).not.toContain("42");
  });

  it("a prompt with `❌` lines and rules does not fail a successful run", () => {
    const prompt = `Checklist:\n❌ item one is not done\n${DIVIDER}\n❌ item two is not done`;
    const result = analyzeLiveRun(withEcho(prompt, REAL_SIMPLE_SUCCESS), prompt, clean);
    expect(result.errorMessage).toBeUndefined();
    expect(result.answer).toBeDefined();
  });

  it("fails closed when the text after `Query:` is not the prompt: an error on a clean exit, nothing trusted after the echo", () => {
    const capture = "Query: rewritten entirely\n" + afterEchoOf(REAL_SIMPLE_SUCCESS);
    const result = analyzeLiveRun(capture, FIXTURE_PROMPT, clean);
    expect(result.echo).toBe("lost");
    expect(result.errorMessage).toContain("not the prompt that was sent");
    expect(result.answer).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.visibleStdout).toBe("");
  });

  it("does not add a verdict for a lost echo when the run did not exit cleanly", () => {
    const result = analyzeLiveRun("Query: rewritten entirely\nrest\n", FIXTURE_PROMPT, { timedOut: true, exitCode: null });
    expect(result.echo).toBe("lost");
    expect(result.errorMessage).toBeUndefined();
  });

  it("an output with no Query: line at all is examined as a whole", () => {
    const result = analyzeLiveRun(afterEchoOf(REAL_SIMPLE_SUCCESS), FIXTURE_PROMPT, clean);
    expect(result.echo).toBe("absent");
    expect(result.answer).toBeDefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it("finds a marker-only failure (no narration) in a wrapped Panel", () => {
    const body = "Context length exceeded (200,000 tokens). Cannot compress further; start a new session with /new.";
    const capture = [
      richEcho(FIXTURE_PROMPT).trimEnd(),
      "Initializing agent...\r",
      `${DIVIDER}\r`,
      "",
      buildPanelBlock("⚕ Hermes", [body.slice(0, 60), body.slice(60)]),
      "",
      "Resume this session with:",
      "  hermes --resume 20260101_120000_a1b2c3",
      "",
      "Session:        20260101_120000_a1b2c3",
      "Duration:       2s",
      "Messages:       2 (1 user, 0 tool calls)",
      "",
    ].join("\n");
    const result = analyzeLiveRun(capture, FIXTURE_PROMPT, clean);
    expect(result.answer).toBeUndefined();
    expect(result.errorMessage).toContain("Context length exceeded");
  });
});
