/**
 * Strip ANSI escape sequences (CSI, OSC) from terminal text.
 * Same pattern used in claude-local adapter quota.ts.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/**
 * Parse Hermes Agent stdout into TranscriptEntry objects for the Paperclip UI.
 *
 * Hermes CLI quiet-mode output patterns:
 *   Assistant:  "  ┊ 💬 {text}"
 *   Tool (TTY): "  ┊ {emoji} {verb:9} {detail}  {duration}"
 *   Tool (pipe): "  [done] ┊ {emoji} {verb:9} {detail}  {duration} ({total})"
 *   System:     "[hermes] ..."
 *
 * We emit structured tool_call/tool_result pairs so Paperclip renders proper
 * tool cards (with status icons, expand/collapse) instead of raw stdout blocks.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

import { TOOL_OUTPUT_PREFIX } from "../shared/constants.js";
// myrmidon(G5): drop the Rich Panel / streaming-box frame around the
// non-quiet final answer
import {
  isPanelRuleLine,
  isPanelTitleLine,
  isStreamBoxFooterLine,
  isStreamBoxHeaderLine,
} from "../shared/myrmidon-panel-frame.js";
// myrmidon(G5): shared with the server-side stripQueryEcho so both agree on
// exactly where the vendor CLI's wrapped "Query:" echo ends
import { isTurnOutputBoundaryLine } from "../shared/myrmidon-turn-output-boundary.js";

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

/**
 * Strip kawaii faces and decorative emoji from a tool summary line.
 * Leaves meaningful emoji (💻 for terminal, 🔍 for search, etc.) intact
 * by only stripping parenthesized kaomoji like (｡◕‿◕｡).
 */
function stripKaomoji(text: string): string {
  // Strip parenthesized kaomoji faces: (｡◕‿◕｡), (★ω★), etc.
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

// ── Line classification ────────────────────────────────────────────────────

/** Check if a ┊ line is an assistant message (┊ 💬 ...). */
function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

/**
 * The vendor CLI's real tool-START line in live-progress mode (non-quiet,
 * `display.streaming` on — the vendor's own default, and untouched by this
 * repo's hermes config generation): `_on_tool_gen_start`
 * (hermes_cli/cli_stream_mixin.py) prints
 * `  ┊ {emoji} preparing {tool_name}…` unconditionally, right before the
 * model's tool call actually runs — well before the `┊ {emoji} {verb} …
 * {duration}` completion line the SAME call later produces via
 * `get_cute_tool_message`. It carries `TOOL_OUTPUT_PREFIX` ("┊") but is not
 * a completion line: handing it to `parseToolCompletionLine` used to
 * fabricate a bogus tool_call/tool_result pair (verb="preparing",
 * detail="{tool_name}…"), so every real tool call rendered as TWO cards —
 * a fake "preparing" one immediately followed by the genuine completion.
 *
 * (`_configure_quiet_agent`, cli.py, nulls `tool_gen_callback` for `-Q`
 * quiet-mode runs, so this line never appears there — only in the
 * live-progress mode, which runs without `-Q`.)
 */
const PREPARING_TOOL_LINE_RE = /^┊\s*\S+\s+preparing\s+\S/;

/** Extract assistant text from a ┊ 💬 line. */
function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

/**
 * Parse a tool completion line into structured data.
 *
 * Handles both TTY and pipe formats:
 *   TTY:  ┊ 💻 $         curl -s "..."  0.1s
 *   Pipe: [done] ┊ 💻 $   curl -s "..."  0.1s (0.5s)
 */
function parseToolCompletionLine(
  line: string,
): { name: string; detail: string; duration: string; hasError: boolean } | null {
  // Strip leading whitespace and [done] prefix
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");

  // Must start with ┊
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  // Remove ┊ prefix and any leading kaomoji face
  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();

  // Now format is: "{emoji} {verb:9} {detail}  {duration}" or "{emoji} {verb:9} {detail}  {duration} ({total})"
  // Example: "💻 $         curl -s ..." or "🔍 search    pattern  0.1s"
  // The verb+detail are separated by whitespace, duration is at the end

  // Match: emoji + verb + detail + duration
  // Duration pattern: N.Ns (possibly followed by (N.Ns))
  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  // Remove duration from the end to get verb + detail
  let verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;
  verbAndDetail = verbAndDetail.replace(/^\p{Emoji_Presentation}\s*/u, "");

  // Check for error suffixes
  const hasError = /\[(?:exit \d+|error|full)\]/.test(verbAndDetail) ||
    /\[error\]\s*$/.test(cleaned);

  // The first token (after emoji) is the verb, rest is detail
  // Verbs are always a single word or symbol ($ for terminal)
  const parts = verbAndDetail.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    return { name: "tool", detail: verbAndDetail, duration, hasError };
  }

  const verb = parts[1];
  const detail = parts[2].trim();

  // Map Hermes verbs to readable tool names
  const nameMap: Record<string, string> = {
    "$": "shell",
    "exec": "shell",
    "terminal": "shell",
    "search": "search",
    "fetch": "fetch",
    "crawl": "crawl",
    "navigate": "browser",
    "snapshot": "browser",
    "click": "browser",
    "type": "browser",
    "scroll": "browser",
    "back": "browser",
    "press": "browser",
    "close": "browser",
    "images": "browser",
    "vision": "browser",
    "read": "read",
    "write": "write",
    "patch": "patch",
    "grep": "search",
    "find": "search",
    "plan": "plan",
    "recall": "recall",
    "proc": "process",
    "delegate": "delegate",
    "todo": "todo",
    "memory": "memory",
    "clarify": "clarify",
    "session_search": "recall",
    "code": "execute",
    "execute": "execute",
    "web_search": "search",
    "web_extract": "fetch",
    "browser_navigate": "browser",
    "browser_click": "browser",
    "browser_type": "browser",
    "browser_snapshot": "browser",
    "browser_vision": "browser",
    "browser_scroll": "browser",
    "browser_press": "browser",
    "browser_back": "browser",
    "browser_close": "browser",
    "browser_get_images": "browser",
    "read_file": "read",
    "write_file": "write_file",
    "search_files": "search",
    "patch_file": "patch",
    "execute_code": "execute",
  };

  const name = nameMap[verb.toLowerCase()] || verb;

  return { name, detail, duration, hasError };
}

// ── Synthetic tool ID generation ────────────────────────────────────────────

let toolCallCounter = 0;

/**
 * Generate a synthetic toolUseId for pairing tool_call with tool_result.
 * Paperclip uses this to match them in normalizeTranscript.
 */
function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

// ── Thinking detection ─────────────────────────────────────────────────────

function isThinkingLine(line: string): boolean {
  return (
    line.includes("💭") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a single line of Hermes stdout into transcript entries.
 *
 * Emits structured tool_call/tool_result pairs (with synthetic IDs) so
 * Paperclip renders proper tool cards with status icons and expand/collapse.
 *
 * @param line  Raw stdout line from Hermes CLI
 * @param ts    ISO timestamp for the entry
 * @returns     Array of TranscriptEntry objects (may be empty)
 */
export function parseHermesStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return [];

  // ── System/adapter messages ────────────────────────────────────────────
  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Non-quiet mode tool start lines: [tool] (kaomoji) emoji verb ... ──
  // These are redundant — the tool_call/tool_result pair arrives later from
  // the ┊ completion line. Skip them to avoid duplicate entries.
  if (trimmed.startsWith("[tool]")) {
    return [];
  }

  // ── MCP / server init noise reclassified from stderr by wrappedOnLog ──
  // Pattern: [2026-03-25T10:40:53.941Z] INFO: ...
  // Emit as stderr so Paperclip groups them into the amber accordion.
  if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Standalone spinner remnants: "💻 Completed", "💻\nCompleted", etc. ─
  // These are non-quiet mode spinner frame leftovers — skip them.
  if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
    return [];
  }

  // ── Session info line ────────────────────────────────────────────────
  if (trimmed.startsWith("session_id:")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Quiet-mode tool/message lines (prefixed with ┊) ────────────────────
  if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
    // Assistant message: ┊ 💬 {text}
    if (isAssistantToolLine(trimmed)) {
      return [{ kind: "assistant", ts, text: extractAssistantText(trimmed) }];
    }

    // myrmidon(G5): the REAL non-quiet (live-progress) tool-START line —
    // `_on_tool_gen_start` (hermes_cli/cli_stream_mixin.py), wired whenever
    // `display.streaming` is on (the vendor's own default; nothing in this
    // repo's hermes config generation overrides it) — is
    // `┊ {emoji} preparing {tool_name}…`, printed once per tool call BEFORE
    // that same call's `┊ {emoji} {verb} {detail} {duration}` completion
    // line below. It is NOT the `[tool]`-prefixed shape this file skips
    // above (that belongs to a different, unrelated fallback path — the
    // quiet-mode `KawaiiSpinner` — this adapter's invocation of the CLI
    // never actually reaches, since `tool_progress_callback` is always
    // wired here). Without this check, `parseToolCompletionLine` parsed
    // "preparing" as the verb and fabricated a fake completion, so every
    // real tool call rendered as TWO cards. See PREPARING_TOOL_LINE_RE's
    // doc comment for the verified vendor source references.
    if (PREPARING_TOOL_LINE_RE.test(trimmed)) {
      return [];
    }

    // Tool completion: ┊ {emoji} {verb} {detail} {duration}
    const toolInfo = parseToolCompletionLine(trimmed);
    if (toolInfo) {
      const id = syntheticToolUseId();
      const detailText = toolInfo.duration
        ? `${toolInfo.detail}  ${toolInfo.duration}`
        : toolInfo.detail;

      return [
        {
          kind: "tool_call" as const,
          ts,
          name: toolInfo.name,
          input: { detail: toolInfo.detail },
          toolUseId: id,
        },
        {
          kind: "tool_result" as const,
          ts,
          toolUseId: id,
          content: detailText,
          isError: toolInfo.hasError,
        },
      ] as TranscriptEntry[];
    }

    // Fallback: raw ┊ line that doesn't match tool format
    const stripped = trimmed
      .replace(/^\[done\]\s*/, "")
      .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
      .trim();
    return [{ kind: "stdout", ts, text: stripped }];
  }

  // ── Rich Panel / streaming-box frame around the non-quiet final answer ──
  // myrmidon(G5): the border rule and title line of the Panel — or the
  // rounded-corner header/footer of the streaming box `display.streaming`
  // (the vendor CLI's default) actually uses for a normal successful turn —
  // that wraps the final response when hermes runs without -Q are chrome,
  // not transcript content — drop them instead of emitting them as garbage
  // "assistant" lines. The frame's inner text lines fall through to the
  // plain-text branch below unchanged (already-trimmed border padding
  // included, for the Panel case; the streaming box has none to begin with).
  if (
    isPanelTitleLine(trimmed) ||
    isPanelRuleLine(trimmed) ||
    isStreamBoxHeaderLine(trimmed) ||
    isStreamBoxFooterLine(trimmed)
  ) {
    return [];
  }

  // ── Vendor CLI's whole-prompt echo (non-quiet single-query mode) ────────
  // myrmidon(G5): `_run_single_query_mode` (cli.py) prints "Query: <prompt>"
  // before the turn starts, where <prompt> is the ENTIRE stdin payload
  // Paperclip sent. This drops the line carrying the "Query:" label. A long
  // prompt that Rich word-wraps across further lines has no marker of its
  // own to recognize per-line — this stateless function only ever sees one
  // line at a time and cannot suppress those continuation lines; they still
  // surface as stray "assistant" lines here. `createHermesStdoutParser`
  // below fixes that for real live transcripts by carrying a small amount
  // of state across calls (see its own doc comment); this function stays as
  // a stateless fallback for callers that only have one line at a time with
  // no way to keep state between calls.
  if (trimmed.startsWith("Query:")) {
    return [];
  }

  // ── Thinking blocks ────────────────────────────────────────────────────
  if (isThinkingLine(trimmed)) {
    return [
      {
        kind: "thinking",
        ts,
        text: trimmed.replace(/^💭\s*/, ""),
      },
    ];
  }

  // ── Error output ───────────────────────────────────────────────────────
  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("Traceback")
  ) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Regular assistant output ───────────────────────────────────────────
  return [{ kind: "assistant", ts, text: trimmed }];
}

/**
 * myrmidon(G5): stateful wrapper around `parseHermesStdoutLine` that also
 * suppresses the WRAPPED CONTINUATION LINES of the vendor CLI's whole-prompt
 * `Query: <prompt>` echo, not just the line carrying the `Query:` label
 * itself.
 *
 * `_query_label` is the entire stdin payload Paperclip sent (agent
 * instructions + wake context + task markdown), and Rich's `Console.print`
 * word-wraps it at the console width with no per-line marker of its own —
 * so on every hermes_local run in live-progress mode (the default), the
 * stateless `parseHermesStdoutLine` used to drop only the first line and
 * then hand every wrapped continuation line to the "regular assistant
 * output" branch, surfacing dozens of spurious `assistant` entries at the
 * top of every live transcript before any real tool call or answer. This
 * carries a "still inside the echo" flag across calls: once a `Query:` line
 * is seen, further lines stay suppressed until `isTurnOutputBoundaryLine`
 * recognizes one that can't be part of the echo (a tool-progress line, the
 * answer's Panel/streaming-box frame, or the exit summary) — the same
 * boundary set the server-side `stripQueryEcho` (myrmidon-live-progress.ts)
 * scans for over the whole (post-hoc) stdout, shared via
 * `../shared/myrmidon-turn-output-boundary.ts` so the two can't disagree.
 *
 * Matches the `createStdoutParser` contract other adapters in this monorepo
 * already use for cross-line state (see e.g. `grok-local`'s
 * `createGrokStdoutParser`): `resolveStdoutParser` (ui/src/adapters/
 * transcript.ts) prefers this over the stateless `parseStdoutLine` whenever
 * an adapter provides it.
 */
export function createHermesStdoutParser() {
  let suppressingQueryEcho = false;
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      const trimmed = stripAnsi(line).trim();
      if (suppressingQueryEcho) {
        if (!isTurnOutputBoundaryLine(trimmed)) return [];
        suppressingQueryEcho = false; // boundary reached: fall through, parse this line normally
      } else if (trimmed.startsWith("Query:")) {
        suppressingQueryEcho = true; // parseHermesStdoutLine below drops this line itself
      }
      return parseHermesStdoutLine(line, ts);
    },
    reset() {
      suppressingQueryEcho = false;
    },
  };
}
