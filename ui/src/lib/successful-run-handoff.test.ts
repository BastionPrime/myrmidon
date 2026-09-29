import { describe, expect, it } from "vitest";
import {
  SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION,
  isSuccessfulRunHandoffComment,
  isSuccessfulRunHandoffEscalationComment,
  successfulRunHandoffActivityTone,
} from "./successful-run-handoff";

describe("successful run handoff UI helpers", () => {
  it("matches both required and escalated production comments", () => {
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(true);
    expect(isSuccessfulRunHandoffComment("## This issue still needs a next step\n\n- Source run: abc")).toBe(true);
    expect(isSuccessfulRunHandoffComment("## Successful run missing issue disposition\n\n- Source run: abc")).toBe(true);
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY)).toBe(true);
    expect(
      isSuccessfulRunHandoffComment(
        "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no clear next-step disposition.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffEscalationComment(
        "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no clear next-step disposition.",
      ),
    ).toBe(true);
    expect(isSuccessfulRunHandoffComment("Ordinary issue comment")).toBe(false);
  });

  // myrmidon(B1): these two bodies are fixed pre-rename literals (comments the
  // server posted before the Paperclip -> Myrmidon rename), not the live
  // constants above, so this test keeps giving a real signal if the legacy
  // match is ever accidentally dropped, unlike asserting a constant against
  // itself.
  it("still recognizes pre-rename comments so old issues keep their alert-card treatment", () => {
    expect(
      isSuccessfulRunHandoffComment(
        "Paperclip needs a disposition before this issue can continue.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffComment(
        "Paperclip could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffEscalationComment(
        "Paperclip could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
      ),
    ).toBe(true);
  });

  // myrmidon(B1): the text the server posts today, written out literally. The UI
  // takes its constants from @paperclipai/shared, so this also fails if the shared
  // constants and the server-posted text ever diverge from what the board renders.
  it("recognizes the comments the server posts under the current product name", () => {
    expect(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY).toBe(
      "Myrmidon needs a disposition before this issue can continue.",
    );
    expect(
      isSuccessfulRunHandoffComment("Myrmidon needs a disposition before this issue can continue."),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffComment(
        "Myrmidon could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffEscalationComment(
        "Myrmidon could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffEscalationComment("Myrmidon needs a disposition before this issue can continue."),
    ).toBe(false);
  });

  it("returns shared tones for required, escalated, and neutral activity", () => {
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION).className).toContain("amber");
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION).className).toContain("red");
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION).className).toContain("border");
  });
});
