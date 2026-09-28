/**
 * myrmidon(G5): mask common secret shapes in Hermes's raw stdout/stderr text
 * before it reaches Paperclip's persisted run log or live transcript.
 *
 * Bypassing `-Q` (see ../server/myrmidon-live-progress.ts) also turns on
 * Hermes's own `tool_progress_mode="all"` default (cli.py
 * `_init_display_options`; only `-Q`'s `_configure_quiet_agent` ever forces
 * it to "off"), which prints each tool call's raw, largely unredacted
 * arguments — notably the full `terminal` command
 * (`agent/display.py`: `"terminal": lambda a, r: f"┊ 💻 $ {build_tool_preview('terminal', a) or ...}"`).
 * The vendor's own `redact_tool_args_for_display` (`agent/display.py`) only
 * masks `browser_type`'s `text` argument — every other tool, including
 * `terminal`/`execute_code`, passes through as-is. A command like
 * `curl -H "Authorization: Bearer sk-..." ...` would otherwise land in
 * Paperclip's stored run log and structured transcript verbatim, for every
 * card this default now applies to.
 *
 * This is deliberately a blunt, content-based safety net over raw text, not
 * a structured per-argument redaction (Hermes gives us rendered lines, not
 * the original argument object at this layer) — it can only mask shapes it
 * recognizes, and it also runs over the agent's own final-answer text (no
 * cheap way at this layer to tell a tool-preview line from answer prose),
 * which is an accepted false-positive in exchange for never storing a real
 * credential. Callers should apply it only to live-progress-mode output —
 * quiet mode (`-Q`) already suppresses tool-progress lines entirely, so
 * there is nothing new to redact there.
 */

const REDACTED = "[REDACTED]";

/** `Authorization: <token>` / `Authorization: Bearer <token>` header text.
 * The token group excludes quote characters — a shell-quoted header, e.g.
 * `curl -H "Authorization: Bearer <token>"`, is exactly the shape this
 * module exists to redact (a `terminal` tool-progress line), and a bare
 * `\S+` is greedy over the closing `"` too, silently dropping it from the
 * redacted output. */
const AUTH_HEADER_RE = /\b(Authorization:\s*(?:Bearer\s+)?)([^\s"']+)/gi;

/** A bare `Bearer <token>` outside an `Authorization:` header, e.g. inside a
 * hand-built `curl -H "Bearer ..."` invocation. */
const BARE_BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g;

/** `key=value` / `token=value` / `secret=value` / `password=value`-shaped
 * assignments, quoted or bare, as they appear in shell args, query strings,
 * env-style invocations, or JSON snippets. The optional `[A-Za-z0-9_-]*`
 * prefix also catches compound env-var names (`DB_PASSWORD=`,
 * `STRIPE_API_KEY=`), which are far more common in real commands than the
 * bare keyword alone.
 *
 * The quoted branch matches up to the actual closing quote — not up to the
 * first whitespace — so a quoted value containing spaces
 * (`password="correct horse battery"`) is still matched and redacted whole;
 * matching `[^\s'",;&]+` unconditionally (as an earlier version of this
 * regex did) cannot consume the space, so the closing-quote backreference
 * can never be reached and the WHOLE match attempt fails, leaving a spaced
 * quoted secret completely unredacted. The unquoted branch keeps the old,
 * whitespace-terminated behavior, since there is no closing delimiter to
 * scan for there. */
const KEY_VALUE_SECRET_RE =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*)(?:(["'])(?:(?!\2)[^\\]|\\.)*\2|[^\s'",;&]+)/gi;

/** `user:password@` credentials embedded in a URL or DB connection string. */
const URL_CREDENTIALS_RE = /(:\/\/)[^/\s:@]+:[^/\s:@]+@/g;

/** Common vendor API-key prefixes, masked whole-match regardless of context. */
const VENDOR_KEY_PREFIX_RES: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * Mask common secret shapes in `text`, replacing each recognized token with
 * `[REDACTED]` while leaving surrounding text (command names, flags, URLs
 * without embedded credentials, plain prose) intact.
 */
export function redactSecretsForLog(text: string): string {
  let out = text
    .replace(AUTH_HEADER_RE, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BARE_BEARER_RE, `Bearer ${REDACTED}`)
    .replace(
      KEY_VALUE_SECRET_RE,
      (_match, prefix: string, quote: string | undefined) =>
        quote ? `${prefix}${quote}${REDACTED}${quote}` : `${prefix}${REDACTED}`,
    )
    .replace(URL_CREDENTIALS_RE, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  for (const re of VENDOR_KEY_PREFIX_RES) out = out.replace(re, REDACTED);
  return out;
}
