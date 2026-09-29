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
 *    EMPTY response, so no error text reaches the run summary or auto-comment.
 *
 * See myrmidon-live-progress.myrmidon.test.ts and
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

function makeCtx(adapterConfig: Record<string, unknown> = {}) {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
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

/** A long prompt echo as the CLI prints it: `Query:` plus Rich-wrapped continuation lines with no per-line marker. */
const WRAPPED_ECHO = [
  'Query: You are "agent-a", an AI agent employee in a Paperclip-managed company.',
  "The checklist for this task:",
  "❌ item one is not done yet",
  "Session:        not-a-real-session-id",
  "(the rest of the full prompt, wrapped across more lines)",
].join("\n");

/** Put a wrapped prompt echo where a capture's own short `Query:` line is. */
function withWrappedEcho(capture: string, prefix = ""): string {
  const firstNewline = capture.indexOf("\n");
  expect(capture.slice(0, firstNewline)).toMatch(/^Query: /);
  return prefix + WRAPPED_ECHO + capture.slice(firstNewline);
}

function mockRun(overrides: { stdout: string; exitCode?: number | null; timedOut?: boolean; stderr?: string }) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    signal: null,
    timedOut: overrides.timedOut ?? false,
    stdout: overrides.stdout,
    stderr: overrides.stderr ?? "",
    pid: null,
    startedAt: null,
  });
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
    mockRun({ stdout: REAL_MULTI_TOOL_SUCCESS });

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
    mockRun({ stdout: REAL_SIMPLE_SUCCESS });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ result: SUCCESS_ANSWER, session_id: FIXTURE_SESSION_ID });
  });

  it("never lets a whole wrapped prompt echo into the response, however the echo is shaped", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // The vendor CLI echoes the ENTIRE prompt before the turn (cli.py
    // _run_single_query_mode). With -w a "✓ Worktree created…" status line
    // prints before it, which defeats stripQueryEcho's leading-line anchor;
    // the answer must come out of the last frame either way.
    for (const prefix of ["", "✓ Worktree created at /workspace/wt\n"]) {
      mockRun({ stdout: withWrappedEcho(REAL_MULTI_TOOL_SUCCESS, prefix) });

      const result = await execute(makeCtx({ worktreeMode: prefix !== "" }) as any);

      expect(result.errorMessage).toBeUndefined();
      const response = result.resultJson!.result as string;
      expect(response).toBe(SUCCESS_ANSWER);
      expect(result.sessionParams).toEqual({ sessionId: FIXTURE_SESSION_ID });
      expect(result.summary).not.toContain("Paperclip-managed company");
    }
  });

  it("does not take the answer or the session from an echoed prompt when the run died before any turn (no exit summary)", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // No recognized boundary ever follows the echo: stripQueryEcho leaves it
    // in place, so nothing on stdout may become the response.
    mockRun({ stdout: WRAPPED_ECHO + "\nstill just wrapped prompt text, nothing else ever printed" });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBeTruthy();
    expect(result.resultJson!.result).toBe("");
    expect(result.summary).toBeUndefined();
    expect(result.sessionParams).toBeUndefined();
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
      mockRun({ stdout, exitCode: 0 });

      const result = await execute(makeCtx({}) as any);

      expect(result.exitCode, label).toBe(0);
      expect(result.errorMessage, label).toMatch(expected);
      // The server builds the run summary and the auto-comment from the
      // response whatever the outcome, so a failed turn must not have one.
      expect(result.resultJson!.result, label).toBe("");
      expect(result.summary, label).toBeUndefined();
    }
  });

  it("flags a run that exits 0 before any turn (missing credentials, --resume not found) and stores no session", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Real early exits: no frame, no exit summary, exit code 0. The loose
    // legacy session regex used to capture the word "from" out of the vendor's
    // own text on this shape and store it as the next run's --resume target.
    for (const stdout of [REAL_EARLY_EXIT_NO_CREDENTIALS, REAL_EARLY_EXIT_SESSION_NOT_FOUND, "Goodbye! ⚕\n", ""]) {
      mockRun({ stdout });

      const result = await execute(makeCtx({}) as any);

      expect(result.errorMessage).toBeTruthy();
      expect(result.exitCode).toBe(0);
      expect(result.sessionParams).toBeUndefined();
      expect(result.sessionDisplayId).toBeUndefined();
      expect(result.resultJson!.result).toBe("");
      expect(result.resultJson!.session_id).toBeNull();
    }
  });

  it("does not flag a killed (timed-out) run the same way — its own timeout diagnostics own that case — and gives it no answer", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    mockRun({
      exitCode: null,
      timedOut: true,
      stdout: '[tool] terminal: curl -s "https://example.com"\n' + buildStreamBox("⚕ Hermes", ["Let me keep going."]),
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
    mockRun({ stdout });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
  });

  it("does not take a 'session_id:' line inside the answer for a quiet-mode session line when running without -Q", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    const stdout =
      buildStreamBox("⚕ Hermes", ["The quiet-mode CLI prints:", "session_id: not-the-real-session-id", "Done."]) +
      "\n" +
      buildExitSummary(SESSION_ID);
    mockRun({ stdout });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.resultJson).toMatchObject({ session_id: SESSION_ID });
    expect(result.resultJson!.result).toContain("Done.");
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
    // parsed final response (stripQueryEcho, covered by the "strips the
    // 'Query:' prompt echo…" test above operates on `result.stdout`, a
    // different code path from `ctx.onLog`).
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_runId, _cmd, _args, opts: any) => {
      await opts.onLog("stdout", "Query: You are \"agent-a\", an AI age");
      await opts.onLog("stdout", "nt employee in a Paperclip-managed company.\n");
      await opts.onLog("stdout", "(the rest of the prompt, wrapped with no per-line marker)\n");
      await opts.onLog("stdout", '[done] ┊ 💻 $         curl -s "https://example.com"  0.1s\n');
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Done.", stderr: "", pid: null, startedAt: null };
    });

    const ctx = makeCtx({});
    await execute(ctx as any);

    const logged = ctx.onLog.mock.calls.map((call) => call[1] as string).join("");
    expect(logged).not.toContain("Query:");
    expect(logged).not.toContain("Paperclip-managed company");
    expect(logged).not.toContain("wrapped with no per-line marker");
    // Real turn output after the echo still reaches the persisted log.
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
