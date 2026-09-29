/**
 * myrmidon(G5): hermes_local live progress without forcing `-Q`.
 *
 * Covers what G5 changes end-to-end through `execute()`, against stdout
 * captured from the installed Hermes CLI (see
 * myrmidon-live-progress.real-output.fixtures.ts) rather than hand-built
 * frames:
 *  - `MYRMIDON_HERMES_LIVE_PROGRESS` (opt-in, default off) drops `-Q` from
 *    the spawn args even when the card's `adapterConfig.quiet` is `true`;
 *  - the session id is read from a non-quiet run's exit summary only;
 *  - the stored response is the last frame alone, with the divider,
 *    intermediate boxes, tool lines, diffs and the exit summary left out;
 *  - a failed turn (the CLI exits 0 anyway) becomes an errorMessage with an
 *    EMPTY response, so no error text reaches the run summary or auto-comment;
 *    so does a turn that ends with an exit summary and no answer frame at all
 *    (a resumed session that failed to initialize) and an early exit before any
 *    turn, whose own message is quoted in the errorMessage;
 *  - the prompt's `Query:` echo is cut exactly by the prompt `execute()` sent on
 *    stdin (every stdout below is built from `opts.stdin`), in the parsed
 *    result and in the run log alike, whatever the prompt holds;
 *  - a `--resume` session the CLI says is gone is dropped (`clearSession`).
 *
 * See myrmidon-live-progress.myrmidon.test.ts, myrmidon-query-echo.myrmidon.test.ts,
 * myrmidon-live-failure-markers.myrmidon.test.ts and
 * shared/myrmidon-panel-frame.myrmidon.test.ts for the unit-level coverage
 * of the pieces this test wires together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import { LIVE_PROGRESS_ENV_VAR } from "./myrmidon-live-progress.js";
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
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(adapterConfig: Record<string, unknown> = {}, storedSessionId?: string) {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig,
    },
    runtime: {
      sessionId: storedSessionId ?? null,
      sessionParams: (storedSessionId ? { sessionId: storedSessionId } : null) as Record<string, unknown> | null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...adapterConfig,
    },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    // Typed params (not just `() => undefined`) so `.mock.calls` below is a
    // real [stream, chunk][] tuple array, not an inferred `[]`.
    onLog: vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

/**
 * The streaming box (`display.streaming: true`, the vendor CLI's default —
 * see shared/myrmidon-panel-frame.ts) a normal successful turn prints.
 */
function buildStreamBox(title: string, bodyLines: string[], width = 80): string {
  const fill = width - 2 - title.length;
  const header = `╭─${title}${"─".repeat(Math.max(fill - 1, 0))}╮`;
  const footer = `╰${"─".repeat(width - 2)}╯`;
  return ["", header, ...bodyLines, footer].join("\n");
}

/** See myrmidon-live-progress.myrmidon.test.ts's own `buildExitSummary` doc
 * comment: `_print_exit_summary()` prints the resume hint immediately after
 * the anchor line — no blank line between them; the blank line comes AFTER
 * the hint(s), before the `Session:` field. */
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

const SESSION_ID = "20260928_143022_ab12cd";
/** The session id every captured fixture carries. */
const FIXTURE_SESSION_ID = "20260101_120000_a1b2c3";

const SUCCESS_ANSWER =
  "Fixed the missing null check in the session lookup.\n\n" +
  "- Verified with a targeted run\n" +
  "- Updated the changelog entry";

/** What a run's stdout is: fixed text, or built from the prompt `execute()` sent on stdin (the CLI echoes that prompt). */
type RunStdout = string | ((prompt: string) => string);

function mockRun(overrides: { stdout: RunStdout; exitCode?: number | null; timedOut?: boolean; stderr?: string }) {
  vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => ({
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    signal: null,
    timedOut: overrides.timedOut ?? false,
    stdout: typeof overrides.stdout === "function" ? overrides.stdout(opts.stdin as string) : overrides.stdout,
    stderr: overrides.stderr ?? "",
    pid: null,
    startedAt: null,
  }));
}

/**
 * A captured run with its own short `Query:` line replaced by the echo of the
 * prompt that was really sent, wrapped the way the CLI wraps it. `prefix` is
 * text the CLI printed before the echo (with -w, a worktree status line).
 */
function echoed(capture: string, prefix = ""): (prompt: string) => string {
  return (prompt) => {
    const firstNewline = capture.indexOf("\n");
    expect(capture.slice(0, firstNewline)).toMatch(/^Query: /);
    return prefix + richEcho(prompt) + capture.slice(firstNewline + 1);
  };
}

/** The echo of the prompt that was sent, then `afterEcho`, exactly as the CLI prints them. */
function echoThen(afterEcho: string): (prompt: string) => string {
  return (prompt) => richEcho(prompt) + afterEcho;
}

/** A Panel like the vendor prints for a failed or non-streamed answer (`box.HORIZONTALS`), body lines padded as it pads them. */
function buildPanel(bodyLines: string[]): string {
  const lines = REAL_FAILED_400.split("\n");
  const title = lines.find((l) => /^ ─  ⚕ Hermes  ─+ *\r?$/.test(l));
  const rule = lines.find((l) => /^ ─+ *\r?$/.test(l));
  expect(title).toBeDefined();
  expect(rule).toBeDefined();
  const blank = " ".repeat(80) + "\r";
  return [title, blank, ...bodyLines.map((l) => ` ${l.padEnd(78)} \r`), blank, rule].join("\n");
}

/** The lines the CLI prints while it starts up, then a Panel answer and the exit summary. */
function panelTurn(bodyLines: string[], sessionId = SESSION_ID): string {
  return "Initializing agent...\r\n\n" + buildPanel(bodyLines) + "\n" + buildExitSummary(sessionId) + "\n";
}

/** Split `text` into chunks of `size` characters, like a pipe delivering it at arbitrary boundaries. */
function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/** What a hermes run printed, quoted the way a task description quotes it inside a prompt (no carriage returns). */
function quotedRun(capture: string): string {
  return capture.replace(/\r/g, "").replaceAll(FIXTURE_SESSION_ID, "20260202_000000_quoted");
}

describe("execute() — G5 live progress wiring", () => {
  const previousEnv = process.env[LIVE_PROGRESS_ENV_VAR];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[LIVE_PROGRESS_ENV_VAR];
    else process.env[LIVE_PROGRESS_ENV_VAR] = previousEnv;
  });

  it("keeps -Q for a card with adapterConfig.quiet=true by default (live progress is opt-in)", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    await execute(makeCtx({ quiet: true }) as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).toContain("-Q");
  });

  it("does not pass -Q for a quiet card once MYRMIDON_HERMES_LIVE_PROGRESS is switched on", async () => {
    process.env[LIVE_PROGRESS_ENV_VAR] = "1";
    await execute(makeCtx({ quiet: true }) as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).not.toContain("-Q");
  });

  it("passes -Q for a quiet card when the flag is off or unrecognized", async () => {
    for (const v of ["0", "ture"]) {
      process.env[LIVE_PROGRESS_ENV_VAR] = v;
      await execute(makeCtx({ quiet: true }) as any);
      const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
      expect(args).toContain("-Q");
    }
  });

  it("reads the session id and only the last box out of a real multi-tool run", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ stdout: echoed(REAL_MULTI_TOOL_SUCCESS) });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.sessionParams).toEqual({ sessionId: FIXTURE_SESSION_ID });
    expect(result.resultJson).toMatchObject({ result: SUCCESS_ANSWER, session_id: FIXTURE_SESSION_ID });
    expect(result.summary).toBe(SUCCESS_ANSWER);
    // Everything else the CLI printed around the answer stays out of it: the
    // query echo, the divider, the earlier streamed boxes, the tool lines, the
    // write_file diff and the exit summary.
    const response = result.resultJson!.result as string;
    for (const leaked of [
      "Query:",
      "─".repeat(40),
      "Let me look at the session lookup code first.",
      "Found it. Now applying the fix.",
      "Verifying the change.",
      "preparing",
      "review diff",
      "session && session.isValid",
      "cat /workspace/session.ts",
      "Resume this session with",
      "Duration:",
    ]) {
      expect(response).not.toContain(leaked);
    }
    expect(response).not.toContain("\r");
  });

  it("reads a real tool-less run", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ stdout: echoed(REAL_SIMPLE_SUCCESS) });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ result: SUCCESS_ANSWER, session_id: FIXTURE_SESSION_ID });
  });

  it("never lets a whole wrapped prompt echo into the response, however the echo is shaped", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // The vendor CLI echoes the ENTIRE prompt before the turn (cli.py
    // _run_single_query_mode). With -w a "✓ Worktree created…" status line
    // prints before it; the echo is cut by the prompt that was sent either way.
    for (const prefix of ["", "✓ Worktree created at /workspace/wt\n"]) {
      const ctx = makeCtx({ worktreeMode: prefix !== "" });
      mockRun({ stdout: echoed(REAL_MULTI_TOOL_SUCCESS, prefix) });

      const result = await execute(ctx as any);

      expect(result.errorMessage).toBeUndefined();
      const response = result.resultJson!.result as string;
      expect(response).toBe(SUCCESS_ANSWER);
      expect(result.sessionParams).toEqual({ sessionId: FIXTURE_SESSION_ID });
      expect(result.summary).not.toContain("Paperclip-managed company");
    }
  });

  it("is not fooled by a prompt that quotes a whole hermes run — frame, failure narration and exit summary included", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // A task description that pastes an earlier run's output. The echo of that
    // prompt holds a Panel with an error, a call to action, a divider, tool
    // lines and an exit summary carrying another session id; none of it may
    // count as this run's output.
    const promptTemplate = [
      "Explain what happened in the two runs below, then do the task.",
      "",
      quotedRun(REAL_FAILED_402_WITH_CALL_TO_ACTION),
      "",
      quotedRun(REAL_MULTI_TOOL_SUCCESS),
      "",
      "Thank you.",
    ].join("\n");
    mockRun({ stdout: echoed(REAL_SIMPLE_SUCCESS) });

    const result = await execute(makeCtx({ promptTemplate }) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ result: SUCCESS_ANSWER, session_id: FIXTURE_SESSION_ID });
    expect(result.sessionParams).toEqual({ sessionId: FIXTURE_SESSION_ID });
    expect(JSON.stringify(result.resultJson)).not.toContain("20260202_000000_quoted");
  });

  it("stores no answer and no session when the run died right after the echo, and says what it printed", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ stdout: echoThen("") });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toMatch(/without printing an exit summary/);
    expect(result.resultJson!.result).toBe("");
    expect(result.summary).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
  });

  it("fails closed when the text after `Query:` is not the prompt that was sent: nothing after it is trusted", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // A CLI release that changes how it echoes the query must not turn into a
    // run that passes with an answer picked out of unaligned text.
    const otherEcho = REAL_SIMPLE_SUCCESS.replace(/^Query: .*$/m, "Query: some other text than the prompt that was sent");
    mockRun({ stdout: otherEcho });

    const result = await execute(makeCtx({}) as any);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toMatch(/not the prompt that was sent/);
    expect(result.resultJson!.result).toBe("");
    expect(result.summary).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
    expect(result.resultJson!.session_id).toBeNull();
  });

  it("flags every real failed turn as failed and leaves the response empty, though the CLI exits 0 with a valid exit summary", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const cases: Array<[string, string, RegExp]> = [
      ["HTTP 400", REAL_FAILED_400, /^HTTP 400: Invalid request/],
      ["HTTP 402 with the call-to-action Panel", REAL_FAILED_402_WITH_CALL_TO_ACTION, /^Billing or credits exhausted: HTTP 402/],
      ["HTTP 429 after retries", REAL_FAILED_429_AFTER_RETRIES, /^API call failed after 3 retries: HTTP 429/],
      ["HTTP 500 after retries", REAL_FAILED_500_AFTER_RETRIES, /^API call failed after 3 retries: HTTP 500/],
    ];
    for (const [label, stdout, expected] of cases) {
      mockRun({ stdout: echoed(stdout), exitCode: 0 });

      const result = await execute(makeCtx({}) as any);

      expect(result.exitCode, label).toBe(0);
      expect(result.errorMessage, label).toMatch(expected);
      // The server builds the run summary and the auto-comment from the
      // response whatever the outcome, so a failed turn must not have one.
      expect(result.resultJson!.result, label).toBe("");
      expect(result.summary, label).toBeUndefined();
    }
  });

  it("flags a `--resume` turn that failed to initialize the agent: an exit summary and no frame is a failure, not a success", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // hermes prints its narration, no answer at all, and then the exit summary
    // of the session that was resumed; exit code 0. Without the check the run
    // is recorded as a success with an empty answer.
    const resumed = "20260103_090000_feed01";
    const ctx = makeCtx({}, resumed);
    mockRun({
      stdout: echoThen(
        "Initializing agent...\r\n" +
          "❌ Failed to initialize agent: provider returned an unexpected response\r\n" +
          buildExitSummary(resumed) +
          "\n",
      ),
    });

    const result = await execute(ctx as any);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).toContain("--resume");
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toMatch(/without printing an answer/);
    expect(result.errorMessage).toContain("Failed to initialize agent");
    expect(result.resultJson!.result).toBe("");
    expect(result.summary).toBeUndefined();
    // The CLI did resume that session, so it is still the one to resume next.
    expect(result.clearSession).toBeUndefined();
  });

  it("flags a failed turn the CLI printed as a plain sentence, with no `Error:` and no cross mark, by the vendor's own wording", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({
      stdout: echoThen(
        panelTurn(["Context length exceeded (131072 tokens). Cannot compress further.", "Try /new to start a fresh session."]),
      ),
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toMatch(/^Context length exceeded \(131072 tokens\)/);
    expect(result.resultJson!.result).toBe("");
    expect(result.summary).toBeUndefined();
  });

  it("still accepts an ordinary non-streamed answer Panel, including one that merely quotes a vendor failure sentence", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    for (const body of [
      ["Fixed the missing null check in the session lookup."],
      ["The log says: Context length exceeded (131072 tokens). That is the limit of the old model."],
    ]) {
      mockRun({ stdout: echoThen(panelTurn(body)) });

      const result = await execute(makeCtx({}) as any);

      expect(result.errorMessage).toBeUndefined();
      expect(result.resultJson!.result).toBe(body.join("\n"));
      expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    }
  });

  it("flags a run that exits 0 before any turn (missing credentials, --resume not found) and stores no session", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Real early exits: no frame, no exit summary, exit code 0. The loose
    // legacy session regex used to capture the word "from" out of the vendor's
    // own text on this shape and store it as the next run's --resume target.
    const cases: Array<[RunStdout, RegExp]> = [
      [echoed(REAL_EARLY_EXIT_NO_CREDENTIALS), /No API key found for provider 'openrouter'/],
      [echoed(REAL_EARLY_EXIT_SESSION_NOT_FOUND), /Session not found: 20200101_000000_nosuch/],
      ["Goodbye! ⚕\n", /printed nothing else/],
      ["", /printed nothing else/],
    ];
    for (const [stdout, vendorMessage] of cases) {
      mockRun({ stdout });

      const result = await execute(makeCtx({}) as any);

      expect(result.errorMessage).toMatch(/without printing an exit summary/);
      // What the vendor said is in the message, so the failure has a cause.
      expect(result.errorMessage).toMatch(vendorMessage);
      expect(result.exitCode).toBe(0);
      expect(result.sessionParams).toBeUndefined();
      expect(result.sessionDisplayId).toBeUndefined();
      expect(result.resultJson!.result).toBe("");
      expect(result.resultJson!.session_id).toBeNull();
      // No `--resume` was passed, so there is no stored session to drop.
      expect(result.clearSession).toBeUndefined();
    }
  });

  it("drops the stored session when the CLI says the one it was asked to resume is gone or cannot be resumed", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const stale = "20200101_000000_nosuch";
    const cases: Array<[string, RunStdout]> = [
      ["not found", echoed(REAL_EARLY_EXIT_SESSION_NOT_FOUND)],
      [
        "over the history cap",
        echoThen("Initializing agent...\r\nCannot resume session: 2400 messages of history, over the 2000 message cap\r\n\nGoodbye! ⚕\n"),
      ],
    ];
    for (const [label, stdout] of cases) {
      mockRun({ stdout });

      const result = await execute(makeCtx({}, stale) as any);

      const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
      expect(args, label).toContain("--resume");
      expect(result.errorMessage, label).toBeTruthy();
      expect(result.clearSession, label).toBe(true);
      expect(result.sessionParams, label).toBeUndefined();
    }
  });

  it("does not drop the stored session for an early exit that is not about the session (missing credentials)", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ stdout: echoed(REAL_EARLY_EXIT_NO_CREDENTIALS) });

    const result = await execute(makeCtx({}, "20260103_090000_feed01") as any);

    expect(result.errorMessage).toMatch(/No API key found/);
    expect(result.clearSession).toBeUndefined();
  });

  it("does not drop the stored session for a turn whose answer merely quotes the CLI's session message", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const stored = "20260103_090000_feed01";
    mockRun({
      stdout: echoThen(
        "Initializing agent...\r\n" +
          buildStreamBox("⚕ Hermes", ["The CLI answers a bad id with:", "Session not found: 20200101_000000_nosuch", "Nothing to do here."]) +
          "\n" +
          buildExitSummary(stored) +
          "\n",
      ),
    });

    const result = await execute(makeCtx({}, stored) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.clearSession).toBeUndefined();
    expect(result.sessionParams).toEqual({ sessionId: stored });
  });

  it("does not drop the stored session for a run that timed out or failed while its streamed answer quoted the CLI's session message", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const stored = "20260103_090000_feed01";
    const quoting = buildStreamBox("⚕ Hermes", ["The CLI answers a bad id with:", "Session not found: 20200101_000000_nosuch"]);
    const unfinished = quoting.split("\n").slice(0, 4).join("\n");
    const divider = "─".repeat(40);
    const cases: Array<[string, { exitCode: number | null; timedOut: boolean }, string]> = [
      ["timed out mid-answer", { exitCode: null, timedOut: true }, unfinished],
      ["timed out after a whole box", { exitCode: null, timedOut: true }, quoting],
      ["exited nonzero", { exitCode: 1, timedOut: false }, quoting],
    ];
    for (const [label, ending, box] of cases) {
      mockRun({ ...ending, stdout: echoThen(`Initializing agent...\r\n${divider}\n${box}\n`) });

      const result = await execute(makeCtx({}, stored) as any);

      const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
      expect(args, label).toContain("--resume");
      expect(result.clearSession, label).toBeUndefined();
    }
  });

  it("does not drop the stored session when a run that timed out printed only the CLI's session message", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ exitCode: null, timedOut: true, stdout: echoed(REAL_EARLY_EXIT_SESSION_NOT_FOUND) });

    const result = await execute(makeCtx({}, "20260103_090000_feed01") as any);

    expect(result.clearSession).toBeUndefined();
  });

  it("does not flag a killed (timed-out) run the same way — its own timeout diagnostics own that case — and gives it no answer", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({
      exitCode: null,
      timedOut: true,
      stdout: echoThen('[tool] terminal: curl -s "https://example.com"\n' + buildStreamBox("⚕ Hermes", ["Let me keep going."])),
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson!.result).toBe("");
  });

  it("does not turn a nonzero exit into the vaguer 'no exit summary' message", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ stdout: "", exitCode: 2 });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBe("Hermes exited with code 2");
  });

  it("is not fooled by a 'Session:'-shaped line inside the agent's own streamed answer", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const stdout =
      buildStreamBox("⚕ Hermes", [
        "Here is the field layout:",
        "Session:        not-the-real-session-id",
        "That is unrelated to this CLI run.",
      ]) +
      "\n" +
      buildExitSummary(SESSION_ID);
    mockRun({ stdout: echoThen(stdout) });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
  });

  it("does not take a 'session_id:' line inside the answer for a quiet-mode session line when running without -Q", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const stdout =
      buildStreamBox("⚕ Hermes", ["The quiet-mode CLI prints:", "session_id: not-the-real-session-id", "Done."]) +
      "\n" +
      buildExitSummary(SESSION_ID);
    mockRun({ stdout: echoThen(stdout) });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.resultJson).toMatchObject({ session_id: SESSION_ID });
    expect(result.resultJson!.result).toContain("Done.");
  });

  it("keeps a rounded diagram and a rule line the model drew in its answer, in a streamed box and in a Panel", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const body = ["The flow is:", "╭────────╮", "│ client │", "╰────────╯", "──────", "Then the server answers."];
    for (const turn of [
      "Initializing agent...\r\n" + buildStreamBox("⚕ Hermes", body) + "\n" + buildExitSummary(SESSION_ID) + "\n",
      panelTurn(body),
    ]) {
      mockRun({ stdout: echoThen(turn) });

      const result = await execute(makeCtx({}) as any);

      expect(result.errorMessage).toBeUndefined();
      expect(result.resultJson!.result).toBe(body.join("\n"));
    }
  });

  it("keeps a rounded diagram in a quiet run's answer too", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const diagram = ["╭────────╮", "│ client │", "╰────────╯"].join("\n");
    mockRun({ stdout: `The flow is:\n${diagram}\n\nsession_id: abc123\n` });

    const result = await execute(makeCtx({ quiet: true }) as any);

    expect(result.resultJson!.result).toBe(`The flow is:\n${diagram}`);
  });

  it("takes the session id from the exit summary at the very end, not from one an answer prints in the same shape", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const quotedSummary = buildExitSummary("20260202_000000_quoted");
    const stdout =
      buildStreamBox("⚕ Hermes", ["The CLI ends every run with a block like this:", ...quotedSummary.split("\n"), "and that is all."]) +
      "\n" +
      buildExitSummary(SESSION_ID);
    mockRun({ stdout: echoThen(stdout) });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.errorMessage).toBeUndefined();
  });

  it("parses quiet-mode stdout exactly as before when -Q is in effect (card quiet, flag unset)", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({ stdout: "All fixed.\n\nsession_id: abc123\n" });

    const result = await execute(makeCtx({ quiet: true }) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ result: "All fixed.", session_id: "abc123" });
    expect(result.sessionParams).toEqual({ sessionId: "abc123" });
  });

  it("redacts secret-shaped tool-progress log chunks before forwarding them to ctx.onLog in live progress mode", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Fake token, built from two literal halves so it never appears as one
    // contiguous secret-shaped literal in the source (this repo's CI runs
    // gitleaks over new commits) — see shared/myrmidon-secret-redaction.myrmidon.test.ts.
    const fakeToken = "sk-ant-" + "abcdef0123456789";
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      // Simulates a `terminal` tool-progress line live progress mode prints
      // (agent/display.py), which the vendor's own redact_tool_args_for_display
      // does not cover — see shared/myrmidon-secret-redaction.ts.
      await opts.onLog("stdout", richEcho(opts.stdin));
      await opts.onLog("stdout", `[done] ┊ 💻 $         curl -H "Authorization: Bearer ${fakeToken}"  0.1s\n`);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Done.", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({});
    await execute(ctx as any);

    const loggedChunks = ctx.onLog.mock.calls.map((call) => call[1] as string);
    expect(loggedChunks.some((c) => c.includes(fakeToken))).toBe(false);
    expect(loggedChunks.some((c) => c.includes("Authorization: Bearer [REDACTED]"))).toBe(true);
  });

  it("redacts a secret whose token is split across two child-process stdout chunks", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Node delivers child-process stdout at OS/pipe read granularity, not at
    // line or token boundaries (adapter-utils' runChildProcess forwards each
    // `data` event to onLog unmodified) — split the same tool-progress line
    // the test above uses across two chunks, landing mid-token.
    const fakeToken = "sk-ant-" + "abcdef0123456789";
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      await opts.onLog("stdout", richEcho(opts.stdin));
      const line = `[done] ┊ 💻 $         curl -H "Authorization: Bearer ${fakeToken}"  0.1s\n`;
      const splitAt = line.indexOf(fakeToken) + 6; // mid-token, not a clean line/word boundary
      await opts.onLog("stdout", line.slice(0, splitAt));
      await opts.onLog("stdout", line.slice(splitAt));
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Done.", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({});
    await execute(ctx as any);

    const logged = ctx.onLog.mock.calls.map((call) => call[1] as string).join("");
    expect(logged).not.toContain(fakeToken);
    expect(logged).toContain("Authorization: Bearer [REDACTED]");
  });

  it("never forwards the raw 'Query:' prompt echo to ctx.onLog, even wrapped across several chunks", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Simulates cli.py's _run_single_query_mode echoing the whole prompt to
    // stdout across several `data` events before any tool or answer output —
    // the raw echo must never reach the persisted run log, not just the
    // parsed final response (the parsed result comes from `result.stdout`, a
    // different code path from `ctx.onLog`).
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      for (const chunk of chunksOf(richEcho(opts.stdin), 37)) await opts.onLog("stdout", chunk);
      await opts.onLog("stdout", '[done] ┊ 💻 $         curl -s "https://example.com"  0.1s\n');
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Done.", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({});
    await execute(ctx as any);

    const logged = ctx.onLog.mock.calls.map((call) => call[1] as string).join("");
    expect(logged).not.toContain("Query:");
    expect(logged).not.toContain("Paperclip-managed company");
    expect(logged).not.toContain("Safe multiline update pattern");
    // Real turn output after the echo still reaches the persisted log.
    expect(logged).toContain("curl -s");
  });

  it("cuts a prompt echo that quotes frames, tool lines, rules and an exit summary out of the log, and only that", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // An echo can hold anything a hermes run prints; the log must drop exactly
    // the echo, and forward what the CLI prints after it — the answer frame
    // and the exit summary here.
    const promptTemplate = [
      "Notes from the previous runs:",
      "╭─ ⚕ Hermes ────────────────────────────────╮",
      "  ┊ 💻 $         cat /workspace/quoted-file.txt  0.1s",
      "────────────────────────────────────────",
      quotedRun(REAL_FAILED_400),
      "Now the task itself.",
    ].join("\n");
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      for (const chunk of chunksOf(richEcho(opts.stdin), 53)) await opts.onLog("stdout", chunk);
      await opts.onLog("stdout", "Initializing agent...\r\n");
      await opts.onLog("stdout", "  ┊ 💻 $         cat /workspace/real-file.txt  0.1s\r\n");
      await opts.onLog("stdout", "Done.\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Done.", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({ promptTemplate });
    await execute(ctx as any);

    const logged = ctx.onLog.mock.calls.map((call) => call[1] as string).join("");
    expect(logged).not.toContain("quoted-file.txt");
    expect(logged).not.toContain("Notes from the previous runs");
    expect(logged).not.toContain("Now the task itself");
    expect(logged).not.toContain("20260202_000000_quoted");
    expect(logged).toContain("real-file.txt");
    expect(logged).toContain("Done.");
  });

  it("forwards what the CLI printed after the echo when it stopped before a turn, so the vendor's message is in the run log", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      for (const chunk of chunksOf(richEcho(opts.stdin), 41)) await opts.onLog("stdout", chunk);
      await opts.onLog("stdout", "\n⚠️  No API key found for provider 'openrouter'.\n");
      await opts.onLog("stdout", "   Run 'hermes model' to choose a provider, or 'hermes setup' for first-time setup.\n\nGoodbye! ⚕\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({});
    const result = await execute(ctx as any);

    const logged = ctx.onLog.mock.calls.map((call) => call[1] as string).join("");
    expect(logged).toContain("No API key found for provider 'openrouter'");
    expect(logged).toContain("hermes setup");
    expect(logged).not.toContain("Paperclip-managed company");
    expect(result.errorMessage).toBeTruthy();
  });

  it("keeps a possibly secret-bearing echo out of the log even when the text after `Query:` is not the prompt", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Alignment lost: the sanitizer falls back to dropping lines until one that
    // can only be turn output.
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      await opts.onLog("stdout", "Query: a query that is not the prompt, with a pasted credential in free text\n");
      await opts.onLog("stdout", "and a second line of it that must not reach the log either\n");
      await opts.onLog("stdout", '[done] ┊ 💻 $         curl -s "https://example.com"  0.1s\n');
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({});
    await execute(ctx as any);

    const logged = ctx.onLog.mock.calls.map((call) => call[1] as string).join("");
    expect(logged).not.toContain("pasted credential");
    expect(logged).not.toContain("second line of it");
    expect(logged).toContain("curl -s");
  });

  it("does not redact (no-op, nothing new to redact) when quiet mode is in effect", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const fakePassword = "hunter" + "2";
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      // Quiet mode never prints tool-progress lines, but the redaction gate
      // itself (useQuiet) must still be verified directly: any stdout chunk
      // passed through must come out byte-for-byte unchanged.
      await opts.onLog("stdout", `password=${fakePassword}\n`);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Done.\n\nsession_id: abc123\n", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({ quiet: true });
    await execute(ctx as any);

    const loggedChunks = ctx.onLog.mock.calls.map((call) => call[1] as string);
    expect(loggedChunks).toContain(`password=${fakePassword}\n`);
  });
});
