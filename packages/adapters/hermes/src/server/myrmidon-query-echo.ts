/**
 * myrmidon(G5): find the end of the vendor CLI's `Query: <prompt>` echo by
 * matching it against the prompt we ourselves sent on stdin.
 *
 * Without `-Q`, `_run_single_query_mode` (cli.py) prints the WHOLE prompt back
 * before the turn starts: `console.print("[bold blue]Query:[/] " +
 * _escape(label))`, where `label` is the stdin payload verbatim (agent
 * instructions, wake context, task markdown). Rich then word-wraps it at the
 * console width. The echo is the only place where arbitrary text of ours can
 * look like the CLI's own output — it can contain frame lines, tool-progress
 * lines, rules, even a pasted copy of a whole earlier hermes run with its exit
 * summary — so guessing where it ends from the shape of the following lines (as
 * the first version of this adapter did) is unsound by construction. We know
 * the prompt, so we do not guess: the echo ends where the prompt's own text
 * ends.
 *
 * What Rich changes when it prints the label (checked in the vendored `rich`
 * sources, console.py / text.py / markup.py / emoji.py / control.py):
 *
 *  - whitespace only: wrapping replaces a space by a line break and drops the
 *    spaces at a wrap point, tabs expand, newlines stay newlines. So the
 *    comparison is done on the non-whitespace characters only;
 *  - control codes 7, 8, 11, 12 and 13 are removed (`strip_control_codes`);
 *    treated like whitespace here, together with the other Unicode separators
 *    Python's `\s` knows and JavaScript's `\s` does not (U+001C..U+001F, U+0085);
 *  - `:name:` emoji shortcodes are replaced by the emoji when `name` is in
 *    Rich's table (`Console.render_str(emoji=True)`), possibly with a variant
 *    selector appended. The table is not ours to duplicate, so a colon pair with
 *    a shortcode-shaped name between them may match 1..16 arbitrary
 *    non-whitespace characters instead of its literal text (only for a prompt
 *    long enough — 24+ significant characters — for that leniency to be
 *    harmless: a few wildcard characters cannot move the end of a long echo);
 *  - markup escaping (`_escape`) round-trips exactly.
 *
 * Anything else that changes the text (a trailing backslash gets doubled, the
 * CLI collecting an image path out of the query, ANSI codes in the prompt) makes
 * the alignment fail. That is deliberate and fails CLOSED: see `QueryEchoState`.
 *
 * Pure text processing, no I/O.
 */

/** Characters that carry no information for the comparison (see the module doc). */
function isIgnorable(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x07 && code <= 0x0d) || // BEL, BS, \t, \n, \v, \f, \r
    (code >= 0x1c && code <= 0x1f) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Below this many significant characters the emoji leniency is off (see the module doc). */
const MIN_SIGNIFICANT_FOR_EMOJI_JUMPS = 24;
/** Longest `name` in a `:name:` shortcode worth treating as one (Rich's longest is well under this). */
const MAX_SHORTCODE_NAME_LENGTH = 80;
/** Longest run of characters an emoji (ZWJ sequence plus variant selector) can be printed as, in UTF-16 units. */
const MAX_EMOJI_UNITS = 16;
/** Skip states are packed as `target * STRIDE + used`, with `used` in 1..MAX_EMOJI_UNITS. */
const SKIP_STRIDE = MAX_EMOJI_UNITS + 1;

/** The prompt reduced to what an echo must reproduce. Compile once, match many times. */
export interface CompiledEchoPrompt {
  /** The prompt's non-ignorable characters, in order. */
  readonly significant: string;
  /**
   * Shortcode leniency: `significant` index of an opening colon -> index just
   * past the closing colon of the `:name:` that starts there.
   */
  readonly shortcodeJumps: ReadonlyMap<number, number>;
}

export function compileEchoPrompt(prompt: string): CompiledEchoPrompt {
  const kept: string[] = [];
  const colons: Array<{ original: number; significant: number }> = [];
  for (let i = 0; i < prompt.length; i++) {
    const code = prompt.charCodeAt(i);
    if (isIgnorable(code)) continue;
    if (code === 0x3a) colons.push({ original: i, significant: kept.length });
    kept.push(prompt[i]);
  }
  const jumps = new Map<number, number>();
  if (kept.length >= MIN_SIGNIFICANT_FOR_EMOJI_JUMPS) {
    for (let k = 0; k + 1 < colons.length; k++) {
      const open = colons[k];
      const close = colons[k + 1];
      const between = close.original - open.original - 1;
      // Rich's pattern is `:(\\S*?):` — the name runs to the NEXT colon and holds no whitespace.
      const hasNoWhitespace = close.significant - open.significant - 1 === between;
      if (between >= 1 && between <= MAX_SHORTCODE_NAME_LENGTH && hasNoWhitespace) {
        jumps.set(open.significant, close.significant + 1);
      }
    }
  }
  return { significant: kept.join(""), shortcodeJumps: jumps };
}

export type EchoFeedStatus = "more" | "done" | "lost";

export interface EchoFeedResult {
  status: EchoFeedStatus;
  /**
   * `done`: index in the fed text just past the echo's last character (for an
   * echo that ended on a shortcode's replacement: the index of the whitespace
   * character that closed it). `lost`: index of the character that broke the
   * alignment. `more`: the length of the fed text.
   */
  end: number;
}

/**
 * Incremental matcher: feed it the text that follows `Query: `, in as many
 * pieces as you like. A small NFA over the prompt's significant characters:
 * normally a single position, several only while a shortcode is being matched.
 */
export class EchoMatcher {
  private readonly significant: string;
  private readonly jumps: ReadonlyMap<number, number>;
  private readonly length: number;
  /** Literal position while the state is a single pointer (`literal === null`). */
  private single = 0;
  private literal: Set<number> | null = null;
  /** Shortcode replacements in progress, packed `target * SKIP_STRIDE + used`. */
  private skip = new Set<number>();
  private outcome: "done" | "lost" | null = null;

  constructor(prompt: CompiledEchoPrompt) {
    this.significant = prompt.significant;
    this.jumps = prompt.shortcodeJumps;
    this.length = prompt.significant.length;
  }

  /** True when a shortcode replacement that would end exactly at the prompt's end is in progress. */
  private tentativelyComplete(): boolean {
    for (const packed of this.skip) {
      if (Math.floor(packed / SKIP_STRIDE) === this.length) return true;
    }
    return false;
  }

  /**
   * Whether the text fed so far is a complete echo if the input ends now: the
   * prompt's last shortcode may have been replaced, and only whitespace (or the
   * end of the output) can close such a replacement.
   */
  finish(): boolean {
    return this.outcome === "done" || this.tentativelyComplete();
  }

  /**
   * Whitespace closes a shortcode's replacement (an emoji is one unbroken
   * word): the prompt's text continues right after the closing colon.
   */
  private endReplacements(): void {
    if (this.skip.size === 0) return;
    const literal = this.literal ?? new Set<number>([this.single]);
    for (const packed of this.skip) {
      const target = Math.floor(packed / SKIP_STRIDE);
      if (target < this.length) literal.add(target);
    }
    this.skip.clear();
    this.literal = literal;
  }

  /** One non-ignorable character. Returns "done", "lost" or "more". */
  private step(char: string): EchoFeedStatus {
    if (this.literal === null) {
      const at = this.single;
      if (!this.jumps.has(at)) {
        if (this.significant[at] !== char) return "lost";
        this.single = at + 1;
        return this.single === this.length ? "done" : "more";
      }
      this.literal = new Set([at]);
    }
    const nextLiteral = new Set<number>();
    const nextSkip = new Set<number>();
    for (const at of this.literal) {
      if (this.significant[at] === char) nextLiteral.add(at + 1);
      const target = this.jumps.get(at);
      if (target !== undefined) nextSkip.add(target * SKIP_STRIDE + 1);
    }
    for (const packed of this.skip) {
      const target = Math.floor(packed / SKIP_STRIDE);
      const used = packed % SKIP_STRIDE;
      if (used < MAX_EMOJI_UNITS) nextSkip.add(target * SKIP_STRIDE + used + 1);
      if (target < this.length && this.significant[target] === char) nextLiteral.add(target + 1);
    }
    this.skip = nextSkip;
    if (nextLiteral.has(this.length)) return "done";
    if (nextLiteral.size === 0 && nextSkip.size === 0) return "lost";
    if (nextSkip.size === 0 && nextLiteral.size === 1) {
      this.single = [...nextLiteral][0];
      this.literal = null;
    } else {
      this.literal = nextLiteral;
    }
    return "more";
  }

  /**
   * Feed `text` from index `from`. Stops at the first character that ends
   * (`done`) or breaks (`lost`) the echo; a matcher that has stopped stays
   * stopped.
   */
  feed(text: string, from = 0): EchoFeedResult {
    if (this.outcome !== null) return { status: this.outcome, end: from };
    for (let index = from; index < text.length; index++) {
      if (isIgnorable(text.charCodeAt(index))) {
        if (this.tentativelyComplete()) {
          this.outcome = "done";
          return { status: "done", end: index };
        }
        this.endReplacements();
        continue;
      }
      const status = this.step(text[index]);
      if (status === "done") {
        this.outcome = "done";
        return { status, end: index + 1 };
      }
      if (status === "lost") {
        this.outcome = "lost";
        return { status, end: index };
      }
    }
    return { status: "more", end: text.length };
  }
}

/**
 * How the prompt's echo relates to a captured stdout.
 *
 *  - `absent`: no `Query:` line, or nothing to align against (an empty
 *    prompt). The whole stdout is the CLI's own output.
 *  - `aligned`: the echo was found and cut exactly; `after` is real output.
 *  - `incomplete`: the echo starts but the output ends before the prompt's
 *    text does (a run killed while echoing). `after` is empty.
 *  - `lost`: a `Query:` line exists but the text after it is not the prompt we
 *    sent. Nothing after it can be told from echo, so nothing after it is
 *    trusted: `after` is empty. Fails closed.
 */
export type QueryEchoState = "absent" | "aligned" | "incomplete" | "lost";

export interface QueryEchoSplit {
  state: QueryEchoState;
  /** Text before the echo's `Query:` line (empty when there is no echo). */
  before: string;
  /** Text after the echo; only meaningful for `absent` (all of stdout) and `aligned`. */
  after: string;
}

/** The echo's first line: `Query:` at column 0 followed by the label. */
export const QUERY_ECHO_LINE_RE = /^Query:[ \t]/;

/**
 * Split a captured stdout around the echo of `prompt`. Candidates are lines
 * starting `Query: `, tried in order; the first one whose text matches the
 * prompt wins (a prompt may itself contain such a line, but only the real echo
 * starts the whole prompt). `after` starts past the rest of the echo's last
 * line, so a blank line the CLI prints next belongs to `after`.
 */
export function splitQueryEcho(stdout: string, prompt: string): QueryEchoSplit {
  const compiled = compileEchoPrompt(prompt);
  if (compiled.significant.length === 0) return { state: "absent", before: "", after: stdout };
  const candidates = /^Query:[ \t]/gm;
  let firstStart = -1;
  for (let found = candidates.exec(stdout); found !== null; found = candidates.exec(stdout)) {
    if (firstStart === -1) firstStart = found.index;
    const matcher = new EchoMatcher(compiled);
    const result = matcher.feed(stdout, found.index + found[0].length);
    if (result.status === "lost") continue;
    const before = stdout.slice(0, found.index);
    if (result.status === "more") {
      if (!matcher.finish()) return { state: "incomplete", before, after: "" };
      return { state: "aligned", before, after: "" };
    }
    const restOfLine = /[ \t]*\r?\n/y;
    restOfLine.lastIndex = result.end;
    const closed = restOfLine.exec(stdout);
    return { state: "aligned", before, after: stdout.slice(closed ? result.end + closed[0].length : result.end) };
  }
  if (firstStart === -1) return { state: "absent", before: "", after: stdout };
  return { state: "lost", before: stdout.slice(0, firstStart), after: "" };
}
