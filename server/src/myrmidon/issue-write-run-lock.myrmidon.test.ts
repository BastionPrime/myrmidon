import { describe, expect, it } from "vitest";
import {
  findLiveIssueWriteRunLock,
  isWriteLockLiveRunCheckEnabled,
  resolveIssueWriteAssigneeRunLock,
  WRITE_LOCK_REQUIRES_LIVE_RUN_ENV,
  type HeartbeatRunLookup,
} from "./issue-write-run-lock.js";

const RUNNING_RUN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const QUEUED_RUN_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const TERMINAL_RUN_ID = "aaaaaaaa-0000-4000-8000-000000000003";

function heartbeatWith(
  statuses: Record<string, string | undefined>,
): HeartbeatRunLookup {
  return {
    async getRun(runId: string) {
      const status = statuses[runId];
      return status === undefined ? null : { status };
    },
  };
}

describe("isWriteLockLiveRunCheckEnabled (myrmidon L5)", () => {
  it("defaults to enabled when the env var is unset or empty", () => {
    expect(isWriteLockLiveRunCheckEnabled({})).toBe(true);
    expect(
      isWriteLockLiveRunCheckEnabled({ [WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]: "" }),
    ).toBe(true);
  });

  it("is enabled for any value other than an explicit 0/false", () => {
    expect(
      isWriteLockLiveRunCheckEnabled({ [WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]: "1" }),
    ).toBe(true);
    expect(
      isWriteLockLiveRunCheckEnabled({ [WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]: "yes" }),
    ).toBe(true);
  });

  it("is disabled only by 0 or false (case-insensitive)", () => {
    expect(
      isWriteLockLiveRunCheckEnabled({ [WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]: "0" }),
    ).toBe(false);
    expect(
      isWriteLockLiveRunCheckEnabled({ [WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]: "False" }),
    ).toBe(false);
  });
});

describe("findLiveIssueWriteRunLock (myrmidon L5)", () => {
  it("reports not live when the issue names no run at all", async () => {
    const result = await findLiveIssueWriteRunLock(heartbeatWith({}), {
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(result).toEqual({ live: false, liveRunId: null });
  });

  it("reports not live when the named run is missing or terminal", async () => {
    const heartbeat = heartbeatWith({ [TERMINAL_RUN_ID]: "succeeded" });

    expect(
      await findLiveIssueWriteRunLock(heartbeat, {
        checkoutRunId: TERMINAL_RUN_ID,
        executionRunId: TERMINAL_RUN_ID,
      }),
    ).toEqual({ live: false, liveRunId: null });

    expect(
      await findLiveIssueWriteRunLock(heartbeat, {
        checkoutRunId: "aaaaaaaa-0000-4000-8000-00000000dead",
        executionRunId: null,
      }),
    ).toEqual({ live: false, liveRunId: null });
  });

  it("reports live for a running execution run", async () => {
    const heartbeat = heartbeatWith({ [RUNNING_RUN_ID]: "running" });
    const result = await findLiveIssueWriteRunLock(heartbeat, {
      checkoutRunId: RUNNING_RUN_ID,
      executionRunId: RUNNING_RUN_ID,
    });
    expect(result).toEqual({ live: true, liveRunId: RUNNING_RUN_ID });
  });

  it("reports live for a queued run", async () => {
    const heartbeat = heartbeatWith({ [QUEUED_RUN_ID]: "queued" });
    const result = await findLiveIssueWriteRunLock(heartbeat, {
      checkoutRunId: QUEUED_RUN_ID,
      executionRunId: null,
    });
    expect(result).toEqual({ live: true, liveRunId: QUEUED_RUN_ID });
  });

  it("falls back to the checkout run when the execution run is terminal", async () => {
    const heartbeat = heartbeatWith({
      [TERMINAL_RUN_ID]: "failed",
      [RUNNING_RUN_ID]: "running",
    });
    const result = await findLiveIssueWriteRunLock(heartbeat, {
      checkoutRunId: RUNNING_RUN_ID,
      executionRunId: TERMINAL_RUN_ID,
    });
    expect(result).toEqual({ live: true, liveRunId: RUNNING_RUN_ID });
  });
});

describe("resolveIssueWriteAssigneeRunLock (myrmidon L5)", () => {
  it("delegates to the live-run lookup when the flag is enabled", async () => {
    const heartbeat = heartbeatWith({ [RUNNING_RUN_ID]: "running" });
    const result = await resolveIssueWriteAssigneeRunLock(
      heartbeat,
      { checkoutRunId: RUNNING_RUN_ID, executionRunId: null },
      {},
    );
    expect(result).toEqual({ live: true, liveRunId: RUNNING_RUN_ID });
  });

  it("allows the write once no run is live", async () => {
    const heartbeat = heartbeatWith({ [TERMINAL_RUN_ID]: "cancelled" });
    const result = await resolveIssueWriteAssigneeRunLock(
      heartbeat,
      { checkoutRunId: TERMINAL_RUN_ID, executionRunId: null },
      {},
    );
    expect(result).toEqual({ live: false, liveRunId: null });
  });

  it("reproduces the pre-L5 status-only lock when explicitly disabled", async () => {
    // The heartbeat lookup is never consulted: any run reference on an
    // in_progress issue is treated as live, matching the old behavior.
    const heartbeat: HeartbeatRunLookup = {
      async getRun() {
        throw new Error("should not be called when the flag is disabled");
      },
    };
    const result = await resolveIssueWriteAssigneeRunLock(
      heartbeat,
      { checkoutRunId: TERMINAL_RUN_ID, executionRunId: null },
      { [WRITE_LOCK_REQUIRES_LIVE_RUN_ENV]: "0" },
    );
    expect(result).toEqual({ live: true, liveRunId: TERMINAL_RUN_ID });
  });
});
