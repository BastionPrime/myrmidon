import { describe, expect, it } from "vitest";

import {
  extractLiveSessionId,
  LIVE_PROGRESS_ENV_VAR,
  LIVE_SESSION_ID_REGEX,
  QUIET_SESSION_ID_REGEX,
  resolveHermesQuietMode,
  stripExitSummary,
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
