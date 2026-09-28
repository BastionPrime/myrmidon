/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat --query-file -` as a child process, streams output,
 * and returns structured results to Paperclip. myrmidon(G5): `-Q` (quiet) is
 * no longer the effective default — see myrmidon-live-progress.ts.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
// myrmidon(S2): allow-listed run environment
import { myrmidonInheritedProcessEnv, readInheritProcessEnvFlag } from "@paperclipai/adapter-utils/myrmidon-run-env";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";
// myrmidon(P4): run-scoped MCP servers, prompt via stdin, spawn envelope check
import {
  applyRuntimeMcpToolsetsToArgs,
  assertSpawnEnvelopeFits,
  materializeRunScopedHermesMcp,
  resolveRuntimeMcpUrlBase,
} from "./myrmidon-runtime-mcp.js";
// myrmidon(M1): card models in the run-scoped config.yaml
import { materializeHermesRunModels } from "./myrmidon-profile-config.js";
// myrmidon(G5): live progress by default (ignore adapterConfig.quiet=true),
// session id in both -Q and non-Q output, Rich Panel frame stripping, and a
// per-run sanitizer (buffered redaction + Query-echo suppression) for the
// raw chunks forwarded to Paperclip's persisted run log
import {
  createLiveLogSanitizer,
  extractLiveAnswerFrame,
  extractLiveSessionId,
  liveModeErrorFromFrame,
  resolveHermesQuietMode,
  stripExitSummary,
  stripQueryEcho,
  stripRichPanelFrames,
} from "./myrmidon-live-progress.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_DEFAULT_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/{{context.issueId}}\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate) || (context.conversationMode === true
    ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
    : HERMES_DEFAULT_PROMPT_TEMPLATE);
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const paperclipTaskMarkdown = selectPaperclipTaskMarkdown(context, {
    resumedSession: options.resumedSession === true,
  });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    conversationMode: context.conversationMode === true,
    resumedSession: options.resumedSession === true,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: paperclipTaskMarkdown.length > 0,
  });
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(renderConditionalSections(template, vars), vars);
  return joinPromptSections([
    wakePrompt,
    sessionHandoffMarkdown,
    paperclipTaskMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  // myrmidon(G5): drop the Rich Panel border/title that live progress mode
  // (no -Q) wraps the final answer in; see myrmidon-live-progress.ts.
  return stripRichPanelFrames(raw)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(
  rawStdout: string,
  stderr: string,
  // myrmidon(G5): only meaningful for the live-progress (no -Q) failure
  // detection below — quiet mode's own success/failure signal is the exit
  // code (`_run_quiet_single_query` calls `sys.exit(1)` on `result.failed`),
  // which execute()'s caller already turns into an errorMessage.
  useQuiet: boolean,
  timedOut: boolean,
  // myrmidon(G5): the "no exit summary" failure signal below only fires for
  // exitCode === 0 — the whole defect it exists for is that live-progress
  // mode reports 0 where it should not; a run that already exited nonzero
  // is already correctly diagnosed by execute()'s own
  // `Hermes exited with code ${exitCode}` fallback (or a real stderr
  // diagnostic), and must not be overridden by this vaguer message.
  exitCode: number | null | undefined,
): ParsedOutput {
  // myrmidon(G5): live progress mode (no -Q) echoes the whole prompt as a
  // "Query: <prompt>" line before any turn output (cli.py
  // _run_single_query_mode); strip it before anything else parses stdout so
  // it never lands in the stored response or (via SESSION_ID_REGEX_LEGACY)
  // gets mistaken for session chrome. No-op for quiet-mode stdout, which
  // never contains this line. See myrmidon-live-progress.ts.
  const stdout = stripQueryEcho(rawStdout);
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // myrmidon(G5): live progress (no -Q) — the final answer is a Rich Panel
    // or streaming box followed by the interactive CLI's exit summary;
    // quiet mode's stderr "session_id:" line never appears here. See
    // myrmidon-live-progress.ts for the verified format (cli.py
    // _print_exit_summary).
    const liveSessionId = extractLiveSessionId(stdout);
    if (liveSessionId) {
      result.sessionId = liveSessionId;
      // myrmidon(G5): the response is ONLY the last frame before the exit
      // summary (the turn's real final answer), not a blanket clean of the
      // whole pre-exit-summary stdout. Multiple frames can appear before it
      // — each burst of streamed commentary between tool calls reopens a
      // new streaming box, and inline tool diffs and the turn's leading
      // '─'*40 divider (cli_chat_turn_mixin.py) sit at the top level,
      // outside any frame — so a blanket clean previously let all of that
      // (plus, for a killed-echo-boundary edge case, the raw 'Query:' prompt
      // echo itself) leak into the stored response. See
      // extractLiveAnswerFrame's doc comment.
      const answerFrame = extractLiveAnswerFrame(stripExitSummary(stdout));
      result.response = answerFrame ? cleanResponse(answerFrame.bodyLines.join("\n")) : undefined;
      // myrmidon(G5): a provider/billing error or similar failure mid-turn
      // still exits 0 without -Q and still prints a valid exit summary
      // (chat() completes normally; only quiet mode's
      // _run_quiet_single_query calls sys.exit on failure) — the one
      // remaining signal is that the answer's own frame is the
      // box.HORIZONTALS error Panel, not the normal streaming box.
      const errorPanelText = liveModeErrorFromFrame(answerFrame);
      if (errorPanelText) {
        result.errorMessage = errorPanelText;
      }
    } else {
      // Legacy/unrecognized format fallback (e.g. a killed run whose exit
      // summary never printed): best effort, as before.
      const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
      if (legacyMatch?.[1]) {
        result.sessionId = legacyMatch?.[1] ?? null;
      }
      if (useQuiet) {
        // Quiet mode never prints a Panel/streaming-box frame at all (Rich
        // display is fully disabled — cli.py _configure_quiet_agent), so a
        // blanket clean of stdout is the only extraction that ever applied
        // here; unchanged from before G5.
        const cleaned = cleanResponse(stdout);
        if (cleaned.length > 0) {
          result.response = cleaned;
        }
      } else {
        // myrmidon(G5): same "only the last frame is the real answer, and
        // no frame at all means no response" rule as the validated-exit-
        // summary branch above, and for the same reason: a blanket clean of
        // the whole stdout here previously let the vendor's `Query:` echo —
        // in the one shape stripQueryEcho itself cannot safely cut, no
        // recognized boundary ever following it (see its own doc comment)
        // — become the stored response outright, in exactly the early-exit-
        // before-any-turn failure case this branch exists to describe.
        const answerFrame = extractLiveAnswerFrame(stdout);
        if (answerFrame) {
          result.response = cleanResponse(answerFrame.bodyLines.join("\n"));
        }
      }
      // myrmidon(G5): without -Q, a run that exits 0 but never printed a
      // validated exit summary is not a killed run's ordinary shape when it
      // was not actually killed by our own timeout — it is
      // _run_single_query_mode exiting before it ever reached a turn at all
      // (no credentials configured, or --resume pointed at a session that
      // was not found or is over the history cap — see
      // myrmidon-live-progress.ts's module doc comment) or some other
      // unrecognized shape. Quiet mode is the only mode where that early
      // exit sets a non-zero exit code (_run_quiet_single_query's own
      // sys.exit(1)); without -Q it reaches Paperclip as exitCode 0 with no
      // errorMessage, so the run is recorded as succeeded and the failure
      // recovery path never triggers.
      if (!useQuiet && !timedOut && exitCode === 0) {
        result.errorMessage =
          "hermes chat exited 0 without a recognized exit summary in live-progress " +
          "mode (an early exit before any turn ran — e.g. missing credentials, or " +
          "--resume pointed at a session that was not found or is over the history " +
          "cap — or an unrecognized output shape)";
      }
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      // myrmidon(H1): report a profile skill copy moved aside in the run log
      const selectedSkills = await reconcileHermesPaperclipSkills(config, undefined, {
        onLog: (line) => ctx.onLog("stdout", line),
      });
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, inject that bundle into the Hermes prompt.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  let prompt = buildPrompt(ctx, config, { resumedSession: Boolean(prevSessionId) });
  if (agentInstructions) {
    prompt = agentInstructions + "\n\n---\n\n" + prompt;
  }

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line.
  // myrmidon(G5): MYRMIDON_HERMES_LIVE_PROGRESS (default on) ignores a card's
  // adapterConfig.quiet=true so hermes_local shows tool-by-tool progress
  // without editing every existing agent card; see myrmidon-live-progress.ts.
  const useQuiet = resolveHermesQuietMode(cfgBoolean(config.quiet) === true);
  // myrmidon(P4): the prompt goes to stdin (`--query-file -`), not argv, so a long
  // task history cannot hit the kernel per-argument limit (E2BIG).
  const args: string[] = ["chat", "--query-file", "-"];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  if (persistSession && prevSessionId) {
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    // myrmidon(S2): allow-listed server env instead of process.env
    ...(myrmidonInheritedProcessEnv(config, "hermes_local") as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  // Wake context travels in the prompt; drop both inherited and configured copies.
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  // myrmidon(P4): materialize ctx.runtimeMcp into a temporary HERMES_HOME and
  // allow the run-scoped servers through `-t`. Agents without assigned
  // connections have no ctx.runtimeMcp and keep the previous behavior.
  let runtimeMcpCleanup: (() => Promise<void>) | null = null;
  try {
    const runtimeMcp = await materializeRunScopedHermesMcp({
      servers: ctx.runtimeMcp?.getServers() ?? [],
      hermesHome: env.HERMES_HOME,
      runId: ctx.runId,
      includeConfiguredServerNames: cfgBoolean(config.includeConfiguredMcpServers) !== false,
      urlBase: resolveRuntimeMcpUrlBase({
        configUrlBase: config.runtimeMcpUrlBase,
        configRewrite: config.runtimeMcpUrlRewrite,
        instanceEnv: process.env,
      }),
      onLog: ctx.onLog,
    });
    if (runtimeMcp) {
      env.HERMES_HOME = runtimeMcp.hermesHome;
      runtimeMcpCleanup = runtimeMcp.cleanup;
      applyRuntimeMcpToolsetsToArgs(args, toolsets, runtimeMcp.toolsetNames);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await ctx.onLog(
      "stdout",
      `[hermes] Warning: run-scoped MCP materialization failed (${reason}); continuing without the connection tools.\n`,
    );
  }

  // myrmidon(M1): card models go into this run's config.yaml, never the profile
  const runModels = await materializeHermesRunModels({ config, hermesHome: env.HERMES_HOME, homeDir: env.HOME, runScopedHome: runtimeMcpCleanup !== null, runId: ctx.runId, provider: resolvedProvider, onLog: ctx.onLog }).catch(async (err) => { await ctx.onLog("stdout", `[hermes] Warning: card models not applied (${err instanceof Error ? err.message : String(err)}).\n`); return null; });
  if (runModels) env.HERMES_HOME = runModels.hermesHome;

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  //
  // Benign patterns that should NOT appear as errors:
  // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
  // - MCP server registration messages
  // - Python import/site noise
  const isBenignStderrLine = (trimmed: string): boolean =>
    /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
    /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
    /Successfully registered all tools/.test(trimmed) ||
    /MCP [Ss]erver/.test(trimmed) ||
    /tool registered successfully/.test(trimmed) ||
    /Application initialized/.test(trimmed);

  const forwardLogLine = (stream: "stdout" | "stderr", line: string) => {
    const chunk = `${line}\n`;
    if (stream === "stderr" && isBenignStderrLine(line.trimEnd())) {
      return ctx.onLog("stdout", chunk);
    }
    return ctx.onLog(stream, chunk);
  };

  // myrmidon(G5): live progress mode's tool-progress lines carry raw,
  // largely unredacted tool arguments (the vendor's own
  // redact_tool_args_for_display only covers browser_type — see
  // shared/myrmidon-secret-redaction.ts) and, before any tool runs, the
  // vendor CLI's whole-prompt `Query:` echo (myrmidon-live-progress.ts).
  // createLiveLogSanitizer buffers each stream's trailing partial line so a
  // secret or that echo's boundary can't hide by straddling two `data`
  // events, redacts secret-shaped text, and drops the echo before any of it
  // reaches Paperclip's persisted run log / live transcript. Quiet mode
  // (-Q) never prints either in the first place, so it skips the sanitizer
  // entirely and stays byte-for-byte unchanged.
  const liveLogSanitizer = useQuiet ? null : createLiveLogSanitizer();

  const wrappedOnLog = async (stream: "stdout" | "stderr", rawChunk: string) => {
    if (!liveLogSanitizer) {
      if (stream === "stderr" && isBenignStderrLine(rawChunk.trimEnd())) {
        return ctx.onLog("stdout", rawChunk);
      }
      return ctx.onLog(stream, rawChunk);
    }
    for (const line of liveLogSanitizer.push(stream, rawChunk)) {
      await forwardLogLine(stream, line);
    }
  };

  // myrmidon(P4): check the spawn envelope, send the prompt on stdin, and remove
  // the run-scoped HERMES_HOME (it holds the gateway token) once the child exits.
  let result: Awaited<ReturnType<typeof runChildProcess>>;
  try {
    assertSpawnEnvelopeFits(args, env);
    result = await runChildProcess(ctx.runId, hermesCmd, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
      stdin: prompt,
      inheritProcessEnv: readInheritProcessEnvFlag(config), // myrmidon(S2)
      runEnvAdapterType: "hermes_local", // myrmidon(S2)
    });
  } finally {
    // myrmidon(G5): flush each stream's buffered trailing partial line (see
    // createLiveLogSanitizer) now that no more chunks are coming, so the
    // very last line isn't silently lost when it never ended in a newline.
    if (liveLogSanitizer) {
      for (const { stream, line } of liveLogSanitizer.flush()) {
        await forwardLogLine(stream, line);
      }
    }
    await runtimeMcpCleanup?.();
    await runModels?.cleanup(); // myrmidon(M1)
  }

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "", useQuiet, result.timedOut, result.exitCode);

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (!result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0) {
    executionResult.errorMessage = `Hermes exited with code ${result.exitCode}`;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}
