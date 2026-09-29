import { describe, expect, it } from "vitest";

import { findVendorFailureMarker, VENDOR_FAILURE_MARKERS } from "./myrmidon-live-failure-markers.js";
import { analyzeLiveTurn } from "./myrmidon-live-progress.js";

/**
 * One answer body per marker, worded as the vendor prints it (hermes-agent
 * 0.21.x `agent/`, see each marker's `source`). The tail of a message that is
 * not part of the marker pattern is illustrative.
 */
const SAMPLES: Record<string, string> = {
  "interpreter-shutdown":
    "Turn abandoned: the process was shutting down before the model call could complete. Start the run again.",
  "partial-overflow":
    "The request no longer fits the model's context window, so the partial response was not continued. Try /compress.",
  "compaction-disabled":
    "Context overflow and auto-compaction is disabled (compression.enabled: false). Enable it or start a new session.",
  "context-length-exceeded":
    "Context length exceeded (200,000 tokens). Cannot compress further; start a new session with /new.",
  "payload-too-large": "Request payload too large (413). Cannot compress further.",
  "compression-timed-out":
    "Context compression timed out without reducing this conversation, so the request was not sent.",
  "output-cap": "max_tokens exceeds the provider's output cap for this model. Lower max_tokens in the config.",
  "invalid-api-response": "Invalid API response after 3 retries: the provider returned an empty choices list.",
  "no-fallback-provider":
    "⏳ Rate limit reached for requests. Resets in 40s.\n\nNo fallback provider available. Try again after the reset, or add a fallback provider in config.yaml.",
  "session-lease-timeout": "⏳ Another Hermes process kept this session busy too long. Try again in a moment.",
  "first-response-truncated": "First response truncated due to output length limit; continuation was not possible.",
  "model-safety-refusal": "⚠️ The model declined to respond to this request (safety refusal). Rephrase the task.",
  "provider-safety-filter": "⚠️ The model provider's safety filter blocked this request. Rephrase the task.",
};

/** Word-wrap at `width` the way Rich wraps a Panel body (whitespace only changes). */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current !== "" && `${current} ${word}`.length > width) {
        out.push(current);
        current = word;
      } else {
        current = current === "" ? word : `${current} ${word}`;
      }
    }
    out.push(current);
  }
  return out;
}

/** The `box.HORIZONTALS` Panel the CLI prints for a failed or non-streamed answer. */
function answerPanel(body: string, width = 80): string {
  const inner = width - 2;
  const title = "─ ⚕ Hermes ";
  const top = ` ${title}${"─".repeat(inner - title.length)} `;
  const blank = ` ${" ".repeat(inner)} `;
  const rows = wrap(body, inner - 2).map((line) => ` ${line.padEnd(inner, " ")} `);
  return ["", top, blank, ...rows, blank, ` ${"─".repeat(inner)} `, ""].join("\r\n");
}

function streamBox(body: string): string {
  return ["", "╭─ ⚕ Hermes ────────────────────────────────╮", ...wrap(body, 70), "╰──────────────────────────────────────────╯", ""].join("\n");
}

describe("VENDOR_FAILURE_MARKERS table", () => {
  it("has a unique id, a start-anchored pattern and a source for every marker", () => {
    const ids = VENDOR_FAILURE_MARKERS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const marker of VENDOR_FAILURE_MARKERS) {
      expect(marker.pattern.source.startsWith("^")).toBe(true);
      expect(marker.source).toMatch(/\.py/);
    }
  });

  it("has a sample below for exactly the markers in the table", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(VENDOR_FAILURE_MARKERS.map((m) => m.id).sort());
  });
});

describe("findVendorFailureMarker", () => {
  for (const marker of VENDOR_FAILURE_MARKERS) {
    it(`recognizes ${marker.id}`, () => {
      expect(findVendorFailureMarker(SAMPLES[marker.id])?.id).toBe(marker.id);
    });

    it(`recognizes ${marker.id} when Rich wrapped the Panel body at the console width`, () => {
      const wrapped = wrap(SAMPLES[marker.id], 30).join("\n");
      expect(findVendorFailureMarker(wrapped)?.id).toBe(marker.id);
    });

    it(`does not recognize ${marker.id} quoted in the middle of an answer`, () => {
      const answer = `Here is what the CLI printed earlier in the log: ${SAMPLES[marker.id]}`;
      expect(findVendorFailureMarker(answer)).toBeUndefined();
    });
  }

  it("does not recognize an ordinary answer or an empty body", () => {
    expect(findVendorFailureMarker("Fixed the null check in the session lookup.")).toBeUndefined();
    expect(findVendorFailureMarker("")).toBeUndefined();
    expect(findVendorFailureMarker("  \n  ")).toBeUndefined();
  });

  it("does not take a provider message with the wait icon but without the fallback sentence", () => {
    expect(findVendorFailureMarker("⏳ Rate limit reached for requests. Resets in 40s.")).toBeUndefined();
  });

  it("takes the fallback sentence after a multi-line provider message", () => {
    const body = "⏳ The provider is overloaded.\nRetry-After: 30\n\n" + SAMPLES["no-fallback-provider"].split("\n\n")[1];
    expect(findVendorFailureMarker(body)?.id).toBe("no-fallback-provider");
  });

  it("does not take the safety-refusal sentence with different wording", () => {
    expect(findVendorFailureMarker("The model declined to respond to this request.")).toBeUndefined();
  });
});

describe("analyzeLiveTurn with a vendor failure marker", () => {
  for (const marker of VENDOR_FAILURE_MARKERS) {
    it(`judges a Panel answer that is ${marker.id} a failure, with the message as the error and no answer`, () => {
      const turn = analyzeLiveTurn(answerPanel(SAMPLES[marker.id]));
      expect(turn.answer).toBeUndefined();
      expect(turn.failureMessage).toBeDefined();
      expect(turn.failureMessage).toContain(SAMPLES[marker.id].split(/[ \n]/)[1]);
    });
  }

  it("does not judge a streamed box a failure whatever it says (model prose)", () => {
    for (const marker of VENDOR_FAILURE_MARKERS) {
      const turn = analyzeLiveTurn(streamBox(SAMPLES[marker.id]));
      expect(turn.failureMessage).toBeUndefined();
      expect(turn.answer?.kind).toBe("stream");
    }
  });

  it("does not judge a Panel answer that only quotes a marker sentence a failure", () => {
    const turn = analyzeLiveTurn(answerPanel(`The log said: ${SAMPLES["context-length-exceeded"]} and I fixed it.`));
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.kind).toBe("panel");
  });

  it("still accepts an ordinary non-streamed Panel answer", () => {
    const turn = analyzeLiveTurn(answerPanel("Fixed the missing null check in the session lookup."));
    expect(turn.failureMessage).toBeUndefined();
    expect(turn.answer?.bodyLines.join(" ")).toContain("Fixed the missing null check");
  });
});
