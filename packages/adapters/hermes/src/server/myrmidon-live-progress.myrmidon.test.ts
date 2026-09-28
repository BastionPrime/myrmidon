import { describe, expect, it } from "vitest";

import {
  createLiveLogSanitizer,
  extractLiveSessionId,
  LIVE_PROGRESS_ENV_VAR,
  LIVE_SESSION_ID_REGEX,
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
 * to stdout after `chat()` returns (hermes_cli/cli_session_mixin.py). */
function buildExitSummary(sessionId: string): string {
  return [
    "",
    "Resume this session with:",
    "",
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

  it("also recognizes the exit summary and the box.HORIZONTALS panel title as boundaries", () => {
    const exitSummaryStdout = ["Query: hi", "", "Resume this session with:", "  hermes --resume abc"].join("\n");
    expect(stripQueryEcho(exitSummaryStdout)).toBe(["Resume this session with:", "  hermes --resume abc"].join("\n"));

    const panelStdout = ["Query: hi", "─ ⚕ Hermes ──────", "Done.", "─────────────────"].join("\n");
    expect(stripQueryEcho(panelStdout)).toBe(["─ ⚕ Hermes ──────", "Done.", "─────────────────"].join("\n"));
  });

  it("is a no-op for quiet-mode stdout (no Query: line at all)", () => {
    const stdout = "Just the final response.\n\nsession_id: 20260928_143022_ab12cd\n";
    expect(stripQueryEcho(stdout)).toBe(stdout);
  });

  it("is a no-op when no recognized boundary follows the echo (e.g. killed before any turn output)", () => {
    const stdout = "Query: Fix the missing null check.\nstill just wrapped prompt text, nothing else ever printed";
    expect(stripQueryEcho(stdout)).toBe(stdout);
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
