/**
 * myrmidon(G5): hermes_local live progress without forcing `-Q`.
 *
 * Covers the three things G5 changes end-to-end through `execute()`:
 *  - `MYRMIDON_HERMES_LIVE_PROGRESS` (default on) drops `-Q` from the spawn
 *    args even when the card's `adapterConfig.quiet` is `true`;
 *  - the session id is read correctly from a non-quiet run's exit summary;
 *  - the stored response is the plain answer, with the Rich Panel frame and
 *    the interactive CLI's exit summary both cut out.
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

/** Layout verified against a real render — see shared/myrmidon-panel-frame.ts. */
function buildPanelBlock(title: string, bodyLines: string[], width = 80): string {
  const inner = width - 2;
  const titleSegment = `─ ${title} `;
  const top = ` ${titleSegment}${"─".repeat(Math.max(inner - titleSegment.length, 0))} `;
  const bottom = ` ${"─".repeat(inner)} `;
  const blank = ` ${" ".repeat(inner)} `;
  const row = (text: string) => ` ${text.padEnd(inner, " ")} `;
  return [top, blank, ...bodyLines.map(row), blank, bottom].join("\r\n");
}

/**
 * The streaming box (`display.streaming: true`, the vendor CLI's default —
 * see shared/myrmidon-panel-frame.ts) a normal successful turn actually
 * prints, as opposed to `buildPanelBlock`'s `box.HORIZONTALS` Panel (only
 * used off-default / on a failed or partial turn).
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

const LIVE_PROGRESS_STDOUT =
  '[tool] terminal: curl -s "https://example.com"\n' +
  '[done] ┊ 💻 $         curl -s "https://example.com"  0.2s (0.3s)\n' +
  buildPanelBlock("⚕ Hermes", [
    "Fixed the missing null check in the session lookup.",
    "",
    "- Verified with a targeted run",
    "- Updated the changelog entry",
  ]) +
  "\n" +
  buildExitSummary(SESSION_ID);

describe("execute() — G5 live progress wiring", () => {
  const previousEnv = process.env[LIVE_PROGRESS_ENV_VAR];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[LIVE_PROGRESS_ENV_VAR];
    else process.env[LIVE_PROGRESS_ENV_VAR] = previousEnv;
  });

  it("does not pass -Q by default, even for a card with adapterConfig.quiet=true", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    await execute(makeCtx({ quiet: true }) as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).not.toContain("-Q");
  });

  it("passes -Q for a quiet card when MYRMIDON_HERMES_LIVE_PROGRESS is turned off", async () => {
    process.env[LIVE_PROGRESS_ENV_VAR] = "0";
    await execute(makeCtx({ quiet: true }) as any);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];
    expect(args).toContain("-Q");
  });

  it("reads the session id and the plain answer out of a realistic non-quiet run", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: LIVE_PROGRESS_STDOUT,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.resultJson).toMatchObject({
      result:
        "Fixed the missing null check in the session lookup.\n\n" +
        "- Verified with a targeted run\n" +
        "- Updated the changelog entry",
      session_id: SESSION_ID,
    });
    expect(result.summary).toBe(
      "Fixed the missing null check in the session lookup.\n\n" +
        "- Verified with a targeted run\n" +
        "- Updated the changelog entry",
    );
    // Senior review round 1: a normal successful turn must never be flagged
    // as failed just because it ran without -Q.
    expect(result.errorMessage).toBeUndefined();
  });

  it("strips the 'Query:' prompt echo and reads the streaming-box answer (display.streaming: true, the default, successful-turn shape)", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // A normal successful turn: the vendor CLI's single-query mode echoes
    // the whole prompt first (cli.py _run_single_query_mode), THEN the
    // already-streamed answer closes into the rounded-corner box (not the
    // box.HORIZONTALS Panel, which only prints for a failed/partial turn).
    const stdout =
      "Query: You are \"agent-a\", an AI agent employee in a Paperclip-managed company. " +
      "(the rest of the full prompt, Rich-wrapped across more lines with no per-line marker)\n" +
      '[tool] terminal: curl -s "https://example.com"\n' +
      '[done] ┊ 💻 $         curl -s "https://example.com"  0.2s (0.3s)\n' +
      buildStreamBox("⚕ Hermes", ["All fixed. See the PR."]) +
      "\n" +
      buildExitSummary(SESSION_ID);

    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.resultJson).toMatchObject({ result: "All fixed. See the PR.", session_id: SESSION_ID });
    expect(result.summary).toBe("All fixed. See the PR.");
    // The echoed prompt must never leak into the persisted response.
    expect(result.resultJson!.result as string).not.toContain("Query:");
    expect(result.resultJson!.result as string).not.toContain("Paperclip-managed company");
    expect(result.errorMessage).toBeUndefined();
  });

  it("does not leak the 'Query:' echo when a '✓ Worktree created…' status line prints before it (-w, worktreeMode), even on a successful turn", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Senior review round 1: with worktreeMode, `_run_single_query_mode`
    // prints this status line BEFORE the 'Query:' echo, so the echo is no
    // longer the first non-blank line of stdout — stripQueryEcho's own
    // boundary heuristic requires that and bails out entirely for this
    // shape (see myrmidon-live-progress.ts's stripQueryEcho doc comment).
    // The response must still come out clean because it is read from the
    // answer's own frame, never from a stripQueryEcho-cleaned blob.
    const stdout =
      "✓ Worktree created at /tmp/hermes-worktree-abc123\n" +
      "Query: You are \"agent-a\", an AI agent employee in a Paperclip-managed company. " +
      "(the rest of the full prompt, Rich-wrapped across more lines with no per-line marker)\n" +
      '[tool] terminal: git status\n' +
      '[done] ┊ 💻 $         git status  0.1s (0.1s)\n' +
      buildStreamBox("⚕ Hermes", ["All fixed. See the PR."]) +
      "\n" +
      buildExitSummary(SESSION_ID);

    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({ worktreeMode: true }) as any);

    expect(result.resultJson).toMatchObject({ result: "All fixed. See the PR.", session_id: SESSION_ID });
    expect(result.resultJson!.result as string).not.toContain("Query:");
    expect(result.resultJson!.result as string).not.toContain("Worktree created");
    expect(result.resultJson!.result as string).not.toContain("Paperclip-managed company");
    expect(result.errorMessage).toBeUndefined();
  });

  it("takes the response ONLY from the final answer frame, dropping the turn divider, an earlier streamed comment, and an inline tool diff", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Senior review round 1: a realistic multi-tool-call turn. Every turn
    // starts with a 40-dash divider (cli_chat_turn_mixin.py); a burst of
    // streamed commentary before a tool call closes into its own box and a
    // NEW box opens for whatever comes after (cli_stream_mixin.py); a
    // completed `write_file`/`terminal` tool prints its own diff review
    // lines at the top level, never inside a frame. None of that is the
    // turn's real answer — only the LAST box is.
    const stdout =
      "─".repeat(40) + "\n" +
      buildStreamBox("⚕ Hermes", ["Let me look at the session lookup code first."]) +
      "\n" +
      '[tool] terminal: write_file session.ts\n' +
      "  ┊ ✍️ write_file session.ts\n" +
      "  ┊ review diff\n" +
      "  ┊ - if (session) {\n" +
      "  ┊ + if (session && session.isValid) {\n" +
      buildStreamBox("⚕ Hermes", [
        "Fixed the missing null check in the session lookup.",
        "",
        "- Verified with a targeted run",
        "- Updated the changelog entry",
      ]) +
      "\n" +
      buildExitSummary(SESSION_ID);

    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({}) as any);

    const response = result.resultJson!.result as string;
    expect(response).toBe(
      "Fixed the missing null check in the session lookup.\n\n" +
        "- Verified with a targeted run\n" +
        "- Updated the changelog entry",
    );
    expect(response).not.toContain("─".repeat(40));
    expect(response).not.toContain("Let me look at the session lookup code first.");
    expect(response).not.toContain("review diff");
    expect(response).not.toContain("session && session.isValid");
    expect(result.errorMessage).toBeUndefined();
  });

  it("flags a run that exits 0 with no recognized exit summary as failed instead of silently succeeding (early exit before any turn ran)", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Senior review round 1: missing credentials, or --resume pointed at a
    // session that was not found or is over the history cap, all exit
    // _run_single_query_mode before it ever reaches a turn — no Panel, no
    // streaming box, no interactive exit summary, just exit code 0.
    for (const stdout of ["Goodbye! ⚕\n", "Session not found.\n", ""]) {
      vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
        pid: null,
        startedAt: null,
      });

      const result = await execute(makeCtx({}) as any);

      expect(result.errorMessage).toBeTruthy();
      expect(result.exitCode).toBe(0);
      // Never the raw stdout mistaken for a real answer.
      expect(result.resultJson!.result as string).not.toBe("Goodbye! ⚕");
    }
  });

  it("does not flag a killed (timed-out) run the same way — its own timeout diagnostics own that case", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: '[tool] terminal: curl -s "https://example.com"\nstill mid-answer, no frame ever closed',
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("flags a provider/billing failure mid-turn using the error Panel's own text, even though the run still exits 0 and still prints a valid exit summary", async () => {
    delete process.env[LIVE_PROGRESS_ENV_VAR];
    // Senior review round 1: `_chat_print_response_panel` falls back to the
    // box.HORIZONTALS Panel (not the streaming box) for a failed/partial
    // turn, and chat() still completes normally afterward — only quiet
    // mode's sys.exit(1) on result.failed would have caught this.
    const stdout =
      '[tool] terminal: curl -s "https://api.example.com/generate"\n' +
      '[done] ┊ 💻 $         curl -s "https://api.example.com/generate"  1.2s (1.2s)\n' +
      buildPanelBlock("⚕ Hermes", ["Error: the provider returned a rate-limit response (429)."]) +
      "\n" +
      buildExitSummary(SESSION_ID);

    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
    expect(result.errorMessage).toBe("Error: the provider returned a rate-limit response (429).");
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

    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx({}) as any);

    expect(result.sessionParams).toEqual({ sessionId: SESSION_ID });
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
    process.env[LIVE_PROGRESS_ENV_VAR] = "0";
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
