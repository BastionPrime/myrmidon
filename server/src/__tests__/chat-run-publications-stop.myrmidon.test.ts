// myrmidon(X8c): a bridged Telegram chat's own /stop must read as "stopped
// at your request", the same as Slack's session stop. Red on vendor code
// (errorCode "chat_session_stopped" falls through to the generic failure
// text instead).

import { describe, expect, it } from "vitest";
import { safeMilestoneText } from "../services/chat-run-publications.js";

describe("chat_session_stopped milestone text (X8c)", () => {
  it("reads as stopped at the conversation owner's request", () => {
    const text = safeMilestoneText({
      agentName: "Agent A",
      errorCode: "chat_session_stopped",
      milestone: "failed",
      issueId: "issue-1",
    });
    expect(text).toBe("Agent A stopped at your request.");
  });

  it("still reads that way for the vendor's own Slack stop code", () => {
    const text = safeMilestoneText({
      agentName: "Agent A",
      errorCode: "slack_session_stopped",
      milestone: "failed",
      issueId: "issue-1",
    });
    expect(text).toBe("Agent A stopped at your request.");
  });

  it("keeps the generic failure text for an unrelated error code", () => {
    const text = safeMilestoneText({
      agentName: "Agent A",
      errorCode: "some_other_error",
      milestone: "failed",
      issueId: "issue-1",
      publicBaseUrl: null,
    });
    expect(text).not.toContain("stopped at your request");
  });
});
