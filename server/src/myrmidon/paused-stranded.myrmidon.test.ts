import { afterEach, describe, expect, it } from "vitest";
import { isOperatorPausedAgent, operatorPauseExemptsStrandedIssue } from "./paused-stranded.js";

describe("isOperatorPausedAgent (L3b)", () => {
  it("is true only for a paused agent with the operator's pause reason", () => {
    expect(isOperatorPausedAgent({ status: "paused", pauseReason: "manual" })).toBe(true);
  });

  it("is false for every system pause reason, a free-text note and a missing reason", () => {
    for (const pauseReason of ["budget", "system", "company_archived", "import", "Provisioned paused by a plugin", null]) {
      expect(isOperatorPausedAgent({ status: "paused", pauseReason })).toBe(false);
    }
  });

  it("is false for an agent that is not paused, even with a leftover reason", () => {
    expect(isOperatorPausedAgent({ status: "idle", pauseReason: "manual" })).toBe(false);
    expect(isOperatorPausedAgent({ status: "terminated", pauseReason: "manual" })).toBe(false);
  });

  it("is false for a missing agent", () => {
    expect(isOperatorPausedAgent(null)).toBe(false);
    expect(isOperatorPausedAgent(undefined)).toBe(false);
  });
});

describe("operatorPauseExemptsStrandedIssue (L3b)", () => {
  const previousDrains = process.env.MYRMIDON_PAUSE_DRAINS;
  const base = {
    drainsEnabled: true,
    issueStatus: "in_progress",
    issueCompanyId: "company-a",
    agent: { companyId: "company-a", status: "paused", pauseReason: "manual" },
  };

  afterEach(() => {
    if (previousDrains === undefined) delete process.env.MYRMIDON_PAUSE_DRAINS;
    else process.env.MYRMIDON_PAUSE_DRAINS = previousDrains;
  });

  it("exempts a todo or in_progress issue of an operator-paused agent", () => {
    expect(operatorPauseExemptsStrandedIssue(base)).toBe(true);
    expect(operatorPauseExemptsStrandedIssue({ ...base, issueStatus: "todo" })).toBe(true);
  });

  it("keeps the vendor behavior when draining is turned off", () => {
    expect(operatorPauseExemptsStrandedIssue({ ...base, drainsEnabled: false })).toBe(false);
  });

  it("reads MYRMIDON_PAUSE_DRAINS itself when the caller does not pass the setting", () => {
    const withoutSetting = { issueStatus: base.issueStatus, issueCompanyId: base.issueCompanyId, agent: base.agent };
    delete process.env.MYRMIDON_PAUSE_DRAINS;
    expect(operatorPauseExemptsStrandedIssue(withoutSetting)).toBe(true);
    process.env.MYRMIDON_PAUSE_DRAINS = "0";
    expect(operatorPauseExemptsStrandedIssue(withoutSetting)).toBe(false);
  });

  it("keeps the vendor behavior for a budget pause and every other system pause reason", () => {
    for (const pauseReason of ["budget", "system", "company_archived", "import", null]) {
      expect(operatorPauseExemptsStrandedIssue({ ...base, agent: { ...base.agent, pauseReason } })).toBe(false);
    }
  });

  it("keeps the vendor behavior for an agent that is not paused", () => {
    expect(operatorPauseExemptsStrandedIssue({ ...base, agent: { ...base.agent, status: "terminated" } })).toBe(false);
    expect(operatorPauseExemptsStrandedIssue({ ...base, agent: { ...base.agent, status: "idle" } })).toBe(false);
  });

  it("keeps the vendor behavior for an in_review issue", () => {
    expect(operatorPauseExemptsStrandedIssue({ ...base, issueStatus: "in_review" })).toBe(false);
  });

  it("keeps the vendor behavior for a missing agent or an agent of another company", () => {
    expect(operatorPauseExemptsStrandedIssue({ ...base, agent: null })).toBe(false);
    expect(operatorPauseExemptsStrandedIssue({ ...base, agent: { ...base.agent, companyId: "company-b" } })).toBe(false);
  });
});
