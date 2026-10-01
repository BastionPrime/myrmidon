import { describe, expect, it } from "vitest";
import {
  DEFAULT_PENDING_INTERACTION_WAKE_GRACE_MS,
  DEFAULT_PENDING_INTERACTION_WAKE_RE_ADMISSIONS,
  PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON,
  PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON,
  PENDING_INTERACTION_WAKE_RE_ADMISSION_LIMIT_REASON,
  PENDING_INTERACTION_WAKE_SWEEP_PAGE_SIZE,
  buildReAdmittedWakePayload,
  decidePendingInteractionWakeAction,
  readPendingInteractionWakeContextSnapshot,
  readPendingInteractionWakeGraceMs,
  readPendingInteractionWakeInteractionId,
  readPendingInteractionWakeReAdmissions,
  selectUndeliveredAddresseeInteractionIds,
} from "./pending-interaction-wake-sweep.js";

const CARD_ID = "d8c4554c-afa1-4f25-a013-bf765573396c";

function facts(overrides: Partial<Parameters<typeof decidePendingInteractionWakeAction>[0]> = {}) {
  return {
    ownRunStillActive: false,
    interactionExists: true,
    interactionWaitsForAddressee: true,
    issueStatus: "in_review",
    activeRunHoldsIssue: false,
    reAdmissionAttempts: 0,
    ...overrides,
  };
}

describe("pending interaction wake sweep settings", () => {
  it("defaults to a ten minute grace window and one re-admission", () => {
    expect(DEFAULT_PENDING_INTERACTION_WAKE_GRACE_MS).toBe(600_000);
    expect(readPendingInteractionWakeGraceMs({})).toBe(600_000);
    expect(DEFAULT_PENDING_INTERACTION_WAKE_RE_ADMISSIONS).toBe(1);
    expect(PENDING_INTERACTION_WAKE_SWEEP_PAGE_SIZE).toBe(50);
  });

  it("reads milliseconds and falls back on invalid values", () => {
    expect(readPendingInteractionWakeGraceMs({ MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS: "60000" })).toBe(60_000);
    expect(readPendingInteractionWakeGraceMs({ MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS: "0" })).toBe(0);
    expect(readPendingInteractionWakeGraceMs({ MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS: "-1" })).toBe(600_000);
    expect(readPendingInteractionWakeGraceMs({ MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS: "10m" })).toBe(600_000);
  });
});

describe("decidePendingInteractionWakeAction", () => {
  it("finalizes a receipt whose interaction no longer waits for its addressee", () => {
    expect(decidePendingInteractionWakeAction(facts({ interactionWaitsForAddressee: false }), { maxReAdmissions: 1 }))
      .toEqual({ kind: "cancel", reason: PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON });
    expect(decidePendingInteractionWakeAction(facts({ interactionExists: false }), { maxReAdmissions: 1 }))
      .toEqual({ kind: "cancel", reason: PENDING_INTERACTION_WAKE_CANCELLED_INTERACTION_REASON });
  });

  it("finalizes a receipt whose task row is gone", () => {
    expect(decidePendingInteractionWakeAction(facts({ issueStatus: null }), { maxReAdmissions: 1 }))
      .toEqual({ kind: "cancel", reason: PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON });
  });

  // myrmidon(N2): a card that still waits for an addressee who was never woken
  // keeps its single delivery even when the task closed first. The task can
  // touch `done` for a minute on its way to a reopen; the card must not die in
  // that window unanswered.
  it("re-admits an undelivered receipt on a closed task and finalizes it after that delivery", () => {
    for (const issueStatus of ["done", "cancelled"]) {
      expect(decidePendingInteractionWakeAction(facts({ issueStatus, reAdmissionAttempts: 0 }), { maxReAdmissions: 1 }))
        .toEqual({ kind: "re_admit" });
      expect(decidePendingInteractionWakeAction(facts({ issueStatus, reAdmissionAttempts: 1 }), { maxReAdmissions: 1 }))
        .toEqual({ kind: "cancel", reason: PENDING_INTERACTION_WAKE_CANCELLED_ISSUE_REASON });
    }
  });

  it("leaves a receipt on a closed task alone while its own run is still going", () => {
    expect(decidePendingInteractionWakeAction(
      facts({ issueStatus: "done", ownRunStillActive: true }),
      { maxReAdmissions: 1 },
    )).toEqual({ kind: "skip", reason: "own_run_active" });
  });

  it("re-admits a receipt whose interaction still waits on a task without a live run", () => {
    expect(decidePendingInteractionWakeAction(facts(), { maxReAdmissions: 1 })).toEqual({ kind: "re_admit" });
    expect(decidePendingInteractionWakeAction(facts({ issueStatus: "todo" }), { maxReAdmissions: 1 })).toEqual({ kind: "re_admit" });
  });

  it("leaves the receipt to the live run that already owns the task", () => {
    expect(decidePendingInteractionWakeAction(facts({ activeRunHoldsIssue: true }), { maxReAdmissions: 1 }))
      .toEqual({ kind: "skip", reason: "active_run_holds_issue" });
  });

  it("leaves the receipt to its own running wake", () => {
    expect(decidePendingInteractionWakeAction(facts({ ownRunStillActive: true }), { maxReAdmissions: 1 }))
      .toEqual({ kind: "skip", reason: "own_run_active" });
    // The own-run check runs first: a terminal own run cannot mask a card that stopped waiting.
    expect(decidePendingInteractionWakeAction(
      facts({ ownRunStillActive: true, interactionWaitsForAddressee: false }),
      { maxReAdmissions: 1 },
    )).toEqual({ kind: "skip", reason: "own_run_active" });
  });

  it("finalizes once the re-admission budget is spent", () => {
    expect(decidePendingInteractionWakeAction(facts({ reAdmissionAttempts: 1 }), { maxReAdmissions: 1 }))
      .toEqual({ kind: "cancel", reason: PENDING_INTERACTION_WAKE_RE_ADMISSION_LIMIT_REASON });
    expect(decidePendingInteractionWakeAction(facts({ reAdmissionAttempts: 1 }), { maxReAdmissions: 2 }))
      .toEqual({ kind: "re_admit" });
  });
});

describe("selectUndeliveredAddresseeInteractionIds", () => {
  const CARD_B = "11111111-2222-3333-4444-555555555555";
  const RUN_ID = "5f0d3d1e-0000-4000-8000-000000000000";

  // myrmidon(N2): only a receipt that exists and never became a run is
  // undelivered; a delivered card and a card with no receipt keep the vendor
  // expiry on a closed task.
  it("keeps the card whose receipt never became a run", () => {
    const rows = [
      { idempotencyKey: `interaction-pending:${CARD_ID}`, runId: null },
      { idempotencyKey: `interaction-pending:${CARD_B}`, runId: RUN_ID },
      { idempotencyKey: "interaction:other", runId: null },
      { idempotencyKey: null, runId: null },
    ];
    expect([...selectUndeliveredAddresseeInteractionIds(rows, [CARD_ID, CARD_B])]).toEqual([CARD_ID]);
  });

  it("ignores a card with no receipt at all", () => {
    expect([...selectUndeliveredAddresseeInteractionIds([], [CARD_ID])]).toEqual([]);
    expect([...selectUndeliveredAddresseeInteractionIds([{ idempotencyKey: null }], [CARD_ID])]).toEqual([]);
  });
});

describe("pending interaction wake payload helpers", () => {
  it("reads the announced interaction id only when it is a uuid", () => {
    expect(readPendingInteractionWakeInteractionId({ interactionId: CARD_ID })).toBe(CARD_ID);
    expect(readPendingInteractionWakeInteractionId({ interactionId: "not-a-card" })).toBeNull();
    expect(readPendingInteractionWakeInteractionId({})).toBeNull();
    expect(readPendingInteractionWakeInteractionId(null)).toBeNull();
  });

  it("counts re-admissions from the sweep marker", () => {
    expect(readPendingInteractionWakeReAdmissions({})).toBe(0);
    expect(readPendingInteractionWakeReAdmissions({ pendingInteractionWakeSweep: { attempt: 2 } })).toBe(2);
    expect(readPendingInteractionWakeReAdmissions({ pendingInteractionWakeSweep: { attempt: 0 } })).toBe(0);
    expect(readPendingInteractionWakeReAdmissions({ pendingInteractionWakeSweep: { attempt: "2" } })).toBe(0);
  });

  it("re-admits the same wake with the marker and without the deferred seed in the payload", () => {
    const payload = {
      issueId: "fb8e3b5e-631b-4825-8dd0-65ab78fae0a2",
      mutation: "interaction",
      interactionId: CARD_ID,
      interactionKind: "request_confirmation",
      _paperclipWakeContext: { source: "issue.interaction.created", wakeReason: "interaction_pending" },
    };
    const next = buildReAdmittedWakePayload(payload, 1, new Date("2026-09-30T12:00:00.000Z"));
    expect(next.mutation).toBe("interaction");
    expect(next.interactionId).toBe(CARD_ID);
    expect(next._paperclipWakeContext).toBeUndefined();
    expect(next.pendingInteractionWakeSweep).toEqual({ attempt: 1, reAdmittedAt: "2026-09-30T12:00:00.000Z" });
    // The deferred seed stays available as the delivery context, unchanged.
    expect(readPendingInteractionWakeContextSnapshot(payload)).toEqual({
      source: "issue.interaction.created",
      wakeReason: "interaction_pending",
    });
    expect(readPendingInteractionWakeContextSnapshot({})).toEqual({});
  });
});