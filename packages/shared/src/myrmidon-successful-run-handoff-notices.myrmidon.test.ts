import { describe, expect, it } from "vitest";
import {
  LEGACY_SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY_PAPERCLIP,
  LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_BODY_PAPERCLIP,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  matchesSuccessfulRunHandoffExhaustedNoticeBody,
  matchesSuccessfulRunHandoffRequiredNoticeBody,
} from "./myrmidon-successful-run-handoff-notices.js";

// The literals below are written out on purpose (not built from the constants):
// comments already stored in a database carry exactly this text, so the tests
// must keep failing if a constant is edited or a legacy match is dropped.
const STORED_REQUIRED_BEFORE_RENAME =
  "Paperclip needs a disposition before this issue can continue.";
const STORED_EXHAUSTED_BEFORE_RENAME =
  "Paperclip could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.";

describe("successful run handoff notice bodies", () => {
  it("names the product in the current bodies and keeps the pre-rename bodies verbatim", () => {
    expect(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY).toBe(
      "Myrmidon needs a disposition before this issue can continue.",
    );
    expect(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY).toBe(
      "Myrmidon could not resolve this issue's missing disposition automatically. The source assignment is unchanged and a board decision is required.",
    );
    expect(LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_BODY_PAPERCLIP).toBe(STORED_REQUIRED_BEFORE_RENAME);
    expect(LEGACY_SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY_PAPERCLIP).toBe(STORED_EXHAUSTED_BEFORE_RENAME);
  });

  it("recognizes the required notice in both the current and the pre-rename text", () => {
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(true);
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody(STORED_REQUIRED_BEFORE_RENAME)).toBe(true);
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody(`  ${STORED_REQUIRED_BEFORE_RENAME}\n`)).toBe(true);
  });

  it("recognizes the exhausted notice in both the current and the pre-rename text", () => {
    expect(matchesSuccessfulRunHandoffExhaustedNoticeBody(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY)).toBe(true);
    expect(matchesSuccessfulRunHandoffExhaustedNoticeBody(STORED_EXHAUSTED_BEFORE_RENAME)).toBe(true);
    expect(matchesSuccessfulRunHandoffExhaustedNoticeBody(`\n${STORED_EXHAUSTED_BEFORE_RENAME}  `)).toBe(true);
  });

  it("keeps the two notices apart and rejects unrelated or extended text", () => {
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY)).toBe(false);
    expect(matchesSuccessfulRunHandoffExhaustedNoticeBody(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(false);
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody("Ordinary issue comment")).toBe(false);
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody("")).toBe(false);
    // Exact match only: a comment that merely starts with the notice is not the notice.
    expect(matchesSuccessfulRunHandoffRequiredNoticeBody(`${STORED_REQUIRED_BEFORE_RENAME} Extra.`)).toBe(false);
    expect(matchesSuccessfulRunHandoffExhaustedNoticeBody(`${SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY} Extra.`)).toBe(false);
  });
});
