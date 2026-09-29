import { describe, expect, it } from "vitest";

import { compileEchoPrompt, EchoMatcher, splitQueryEcho } from "./myrmidon-query-echo.js";
import { richEcho } from "./myrmidon-query-echo.fixtures.js";
import {
  REAL_FAILED_402_WITH_CALL_TO_ACTION,
  REAL_MULTI_TOOL_SUCCESS,
} from "./myrmidon-live-progress.real-output.fixtures.js";

const REAL_OUTPUT_AFTER_ECHO = ["Initializing agent...", "───────────", "real output line"].join("\n") + "\n";

describe("EchoMatcher", () => {
  it("consumes the prompt whatever whitespace separates its words", () => {
    const matcher = new EchoMatcher(compileEchoPrompt("alpha beta  gamma\n\ndelta"));
    expect(matcher.feed("alpha\n beta gamma\t\ndelta\nrest")).toEqual({ status: "done", end: "alpha\n beta gamma\t\ndelta".length });
  });

  it("returns the same result however the text is cut into pieces", () => {
    const prompt = "one two three four five six seven eight nine ten eleven twelve";
    const echo = richEcho(prompt, { width: 20 }).slice("Query: ".length);
    for (const size of [1, 3, 7, echo.length]) {
      const matcher = new EchoMatcher(compileEchoPrompt(prompt));
      let last: ReturnType<EchoMatcher["feed"]> = { status: "more", end: 0 };
      for (let at = 0; at < echo.length && last.status === "more"; at += size) {
        last = matcher.feed(echo.slice(at, at + size));
      }
      expect(last.status).toBe("done");
    }
  });

  it("reports a mismatch at the character that broke it", () => {
    const matcher = new EchoMatcher(compileEchoPrompt("the quick brown fox"));
    expect(matcher.feed("the quick brawn fox")).toEqual({ status: "lost", end: 12 });
    expect(matcher.feed("anything", 0).status).toBe("lost"); // stays stopped
  });

  it("is not done while the prompt's text has not all arrived", () => {
    const matcher = new EchoMatcher(compileEchoPrompt("the quick brown fox"));
    expect(matcher.feed("the quick brown").status).toBe("more");
    expect(matcher.finish()).toBe(false);
  });
});

describe("splitQueryEcho — exact cut by the known prompt", () => {
  it("cuts a one-line echo and hands back everything after it", () => {
    const prompt = "Fix the null check in session.ts and report.";
    const split = splitQueryEcho(richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split).toEqual({ state: "aligned", before: "", after: REAL_OUTPUT_AFTER_ECHO });
  });

  it("cuts a long wrapped multi-paragraph prompt with indentation, tabs and blank lines", () => {
    const prompt = [
      "You are agent-a, a coding agent working for example.com. Follow the instructions below and report back when the work is done.",
      "",
      "## Task",
      "\t- first step: read the failing test and the module it covers, then decide what is wrong with the module",
      "    - second step: fix it",
      "",
      "Thank you.  ",
    ].join("\n");
    const split = splitQueryEcho(richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("is not fooled by an echoed prompt that holds a lone stream-box header", () => {
    const prompt = ["Notes from the last run:", "╭─ ⚕ Hermes ────────────────────╮", "the answer was cut off here", "please continue"].join("\n");
    const split = splitQueryEcho(richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("is not fooled by tool-progress lines and rules in the echoed prompt", () => {
    const prompt = [
      "Earlier transcript, for context:",
      "  ┊ 💻 preparing terminal…",
      "  ┊ 💻 $         cat /workspace/session.ts  0.1s",
      "────────────────────────────────────────",
      "╭─ ⚕ Hermes ────────────────────────────╮",
      "Let me look at the code first.",
      "╰───────────────────────────────────────╯",
      "─ ⚕ Hermes ────────────────────────────",
      "  Something went wrong.",
      "────────────────────────────────────────",
      "and now the actual request: do it again",
    ].join("\n");
    const split = splitQueryEcho(richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("is not fooled by an echoed prompt that quotes a whole hermes run, exit summary and all", () => {
    for (const quoted of [REAL_MULTI_TOOL_SUCCESS, REAL_FAILED_402_WITH_CALL_TO_ACTION]) {
      const prompt = `Here is what the previous run printed:\n${quoted.replace(/\r/g, "")}\nExplain it.`;
      const real = "Initializing agent...\nreal output line\n";
      const split = splitQueryEcho(richEcho(prompt) + real, prompt);
      expect(split.state).toBe("aligned");
      expect(split.after).toBe(real);
    }
  });

  it("keeps the text before the echo's own line as `before`", () => {
    const prompt = "do the thing that was asked, in full detail";
    const split = splitQueryEcho("warming up...\n" + richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split).toEqual({ state: "aligned", before: "warming up...\n", after: REAL_OUTPUT_AFTER_ECHO });
  });

  it("takes the echo of the prompt even when the prompt has a `Query: ` line of its own", () => {
    const prompt = ["Something to look up.", "Query: what is in the second paragraph?", "Answer in one line."].join("\n");
    const split = splitQueryEcho(richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("skips an earlier `Query:` line that is not the echo of this prompt", () => {
    const prompt = "the real prompt, long enough to be recognized";
    const stdout = "Query: some other tool's line\n" + richEcho(prompt) + REAL_OUTPUT_AFTER_ECHO;
    const split = splitQueryEcho(stdout, prompt);
    expect(split.state).toBe("aligned");
    expect(split.before).toBe("Query: some other tool's line\n");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("treats everything after the echo as real output, even text that looks like an echo", () => {
    const prompt = "a prompt that is quite ordinary and long enough";
    const later = "Query: the model quoting the vendor's own echo line\nmore\n";
    const split = splitQueryEcho(richEcho(prompt) + later, prompt);
    expect(split.after).toBe(later);
  });

  it("leaves text that follows the prompt on the echo's last line in `after`", () => {
    const prompt = "a prompt that is quite ordinary and long enough";
    const split = splitQueryEcho(`Query: ${prompt} [extra]\nnext\n`, prompt);
    expect(split).toEqual({ state: "aligned", before: "", after: " [extra]\nnext\n" });
  });

  it("accepts CRLF line endings and control codes in the echo", () => {
    const prompt = "first line of the prompt\nsecond line of the prompt\x07 with a bell";
    const echo = richEcho(prompt).replace(/\n/g, "\r\n");
    const split = splitQueryEcho(echo + "real\r\n", prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe("real\r\n");
  });

  it("works for a prompt of a couple of hundred kilobytes", () => {
    const prompt = Array.from({ length: 4000 }, (_, i) => `line ${i}: some words to fill the paragraph up to a decent width`).join("\n");
    const started = Date.now();
    const split = splitQueryEcho(richEcho(prompt) + "done\n", prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("splitQueryEcho — emoji shortcodes Rich replaces", () => {
  const emoji = { ":white_check_mark:": "✅", ":warning:": "⚠️", ":family_man_woman_girl_boy:": "👨‍👩‍👧‍👦" };

  it("matches a shortcode that was replaced by its emoji", () => {
    const prompt = "Checklist for the release :white_check_mark: tests pass :warning: docs missing, please review";
    const split = splitQueryEcho(richEcho(prompt, { emoji }) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("matches an emoji made of a long joined sequence", () => {
    const prompt = "The whole team :family_man_woman_girl_boy: is invited to the release party on Friday";
    const split = splitQueryEcho(richEcho(prompt, { emoji }) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("matches a prompt that ends on a replaced shortcode", () => {
    const prompt = "Please confirm that everything above is understood, thanks :white_check_mark:";
    const split = splitQueryEcho(richEcho(prompt, { emoji }) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("still matches a shortcode Rich did not know and left as it was", () => {
    const prompt = "Use the :not_an_emoji: marker in the label, and the :warning: one otherwise";
    const split = splitQueryEcho(richEcho(prompt, { emoji }) + REAL_OUTPUT_AFTER_ECHO, prompt);
    expect(split.state).toBe("aligned");
    expect(split.after).toBe(REAL_OUTPUT_AFTER_ECHO);
  });

  it("does not tolerate wildcard characters in a short prompt (fails closed instead)", () => {
    const prompt = "ok :warning: go";
    expect(splitQueryEcho(richEcho(prompt, { emoji }) + "real\n", prompt).state).toBe("lost");
  });
});

describe("splitQueryEcho — states that are not `aligned`", () => {
  const prompt = "the prompt that was sent on stdin, at a reasonable length";

  it("is `absent` without a `Query:` line, and hands over all of stdout", () => {
    expect(splitQueryEcho("Traceback (most recent call last):\n  boom\n", prompt)).toEqual({
      state: "absent",
      before: "",
      after: "Traceback (most recent call last):\n  boom\n",
    });
  });

  it("is `absent` for an empty prompt: there is nothing to align against", () => {
    expect(splitQueryEcho("Query: \nreal\n", " \n\t").state).toBe("absent");
  });

  it("is `lost` when the text after `Query:` is not the prompt, and trusts nothing after it", () => {
    const split = splitQueryEcho("Query: a different prompt entirely\n╭─ ⚕ Hermes ─╮\nanswer\n╰───╯\n", prompt);
    expect(split).toEqual({ state: "lost", before: "", after: "" });
  });

  it("is `incomplete` when the output ends in the middle of the prompt", () => {
    const echo = richEcho(prompt);
    const split = splitQueryEcho(echo.slice(0, echo.length - 20), prompt);
    expect(split.state).toBe("incomplete");
    expect(split.after).toBe("");
  });

  it("does not match a `Query:` that is not at the start of a line", () => {
    expect(splitQueryEcho(`  Query: ${prompt}\n`, prompt).state).toBe("absent");
  });
});
