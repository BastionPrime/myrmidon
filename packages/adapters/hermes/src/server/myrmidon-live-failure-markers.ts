/**
 * myrmidon(G5): the turn-ending failure texts the vendor CLI prints as the
 * answer Panel of a turn whose result has `failed=True`.
 *
 * Without `-Q` the CLI exits 0 whatever happened, and quiet mode's own
 * `sys.exit(1)` on `result.failed` is not reachable from this repository (the
 * vendor source is read-only here). The first-line signals `analyzeLiveTurn`
 * uses (`Error:` prefix, column-0 `❌` narration, the billing call to action)
 * do not cover every branch that sets `failed=True`: several of them print a
 * plain sentence as `final_response` and no narration at all. This table lists
 * those sentences, each taken from the vendor source (hermes-agent 0.21.x,
 * `agent/`), so that a Panel answer starting with one of them is a failure.
 *
 * Deliberately conservative:
 *
 *  - only a Panel answer is checked (`is_error_response` makes the CLI print a
 *    Panel; a streamed box is model prose and can say anything);
 *  - each pattern is anchored to the start of the answer where the vendor
 *    text starts the message, so a model quoting one of these sentences in the
 *    middle of an ordinary Panel answer (streaming off) is not flagged;
 *  - whitespace is collapsed before matching: Rich wraps the Panel body at the
 *    console width.
 *
 * NOT covered, on purpose: a `failed=True` result whose `final_response` is the
 * model's own text (`session_persistence_failed`, the truncation-continuation
 * fallbacks) — it prints exactly like a successful non-streamed answer, so no
 * text tells the two apart. That residual risk is listed in DIVERGENCE.md.
 *
 * The table is tied to the CLI's wording; a vendor release that rewords a
 * message turns it into a silent miss, not a false alarm. It is only consulted
 * in live-progress mode, which is opt-in (`MYRMIDON_HERMES_LIVE_PROGRESS`).
 */

export interface VendorFailureMarker {
  /** Short stable name, for tests and messages. */
  id: string;
  /** Matched against the answer body with whitespace collapsed to single spaces. */
  pattern: RegExp;
  /** Where in the vendor source the text comes from (file under `agent/`). */
  source: string;
}

export const VENDOR_FAILURE_MARKERS: readonly VendorFailureMarker[] = [
  {
    id: "interpreter-shutdown",
    pattern: /^Turn abandoned: the process was shutting down before the model call could complete\./,
    source: "turn_api_error.py",
  },
  {
    id: "partial-overflow",
    pattern: /^The request no longer fits the model's context window, so the partial response was not continued\./,
    source: "turn_truncation.py",
  },
  {
    id: "compaction-disabled",
    pattern: /^Context overflow and auto-compaction is disabled \(compression\.enabled: false\)\./,
    source: "turn_recovery.py",
  },
  {
    id: "context-length-exceeded",
    pattern: /^Context length exceeded(?::| \()/,
    source: "turn_overflow.py, conversation_loop.py",
  },
  {
    id: "payload-too-large",
    pattern: /^Request payload too large(?::| \()/,
    source: "turn_overflow.py",
  },
  {
    id: "compression-timed-out",
    pattern: /^Context compression timed out (?:without reducing this conversation|before it could commit)\b/,
    source: "turn_truncation.py, turn_context.py",
  },
  {
    id: "output-cap",
    pattern: /^max_tokens exceeds the provider's output cap for this model\./,
    source: "turn_overflow.py",
  },
  {
    id: "invalid-api-response",
    pattern: /^Invalid API response after \d+ retries\b/,
    source: "turn_response_check.py",
  },
  {
    // `final_response` is "⏳ <provider message>", a blank line, then this sentence.
    id: "no-fallback-provider",
    pattern: /^⏳ .*\bNo fallback provider available\. Try again after the reset, or add a fallback provider in config\.yaml\./,
    source: "turn_api_call.py",
  },
  {
    id: "session-lease-timeout",
    pattern: /^⏳ Another Hermes process kept this session busy too long\./,
    source: "turn_facade_lease.py",
  },
  {
    id: "first-response-truncated",
    pattern: /^First response truncated due to output length limit\b/,
    source: "turn_truncation.py",
  },
  {
    id: "model-safety-refusal",
    pattern: /^⚠️? The model declined to respond to this request \(safety refusal\b/,
    source: "turn_truncation.py",
  },
  {
    id: "provider-safety-filter",
    pattern: /^⚠️? The model provider's safety filter blocked this request\b/,
    source: "turn_recovery.py",
  },
];

/** The marker a Panel answer body starts with (or contains, for the one that trails a provider message), if any. */
export function findVendorFailureMarker(answerBody: string): VendorFailureMarker | undefined {
  const normalized = answerBody.replace(/\s+/g, " ").trim();
  if (normalized === "") return undefined;
  return VENDOR_FAILURE_MARKERS.find((marker) => marker.pattern.test(normalized));
}
