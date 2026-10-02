import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLock } from "../services/agent-start-lock.ts";

// myrmidon(START-LOCK-REENTRY): a queued-run start can re-enter the start lock
// for its own agent (a non-invokable agent cancels its active runs, and every
// cancellation promotes the next queued run). That nested start used to wait
// for a marker that settles only after it returns, so it stalled until the
// stale timeout (30 s) and warned. These cases pin both halves: the nested
// start runs at once, and every start from another async chain still waits.

async function flushMicrotasks(times = 20) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("agent start lock re-entry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a run that re-enters its own lock without waiting for the stale timeout", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const nestedStart = vi.fn(async () => "nested");
    let settled = false;

    const reentrantStart = withAgentStartLock(agentId, () =>
      withAgentStartLock(agentId, nestedStart),
    ).then((value) => {
      settled = true;
      return value;
    });

    // Only microtasks, no timer advance: waiting for the stale timeout would
    // leave the start pending here.
    await flushMicrotasks();

    expect(settled).toBe(true);
    await expect(reentrantStart).resolves.toBe("nested");
    expect(nestedStart).toHaveBeenCalledTimes(1);
  });

  it("still makes a start from another async chain wait for the in-flight start", async () => {
    const agentId = randomUUID();
    let finishFirstStart: () => void = () => undefined;
    const firstStart = withAgentStartLock(
      agentId,
      () =>
        new Promise<void>((resolve) => {
          finishFirstStart = resolve;
        }),
    );
    await flushMicrotasks();

    const secondStart = vi.fn(async () => "second");
    const queuedStart = withAgentStartLock(agentId, secondStart);
    await flushMicrotasks();
    expect(secondStart).not.toHaveBeenCalled();

    finishFirstStart();
    await expect(queuedStart).resolves.toBe("second");
    await expect(firstStart).resolves.toBeUndefined();
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  it("keeps a start from a detached execution that outlived the lock body waiting", async () => {
    const agentId = randomUUID();
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const detachedStart = vi.fn(async () => "detached");

    let detachedRun: Promise<string> | undefined;
    await withAgentStartLock(agentId, async () => {
      // Started inside the lock body, settled long after the body returned:
      // it must wait for a later holder like any other chain.
      detachedRun = (async () => {
        await gate;
        return withAgentStartLock(agentId, detachedStart);
      })();
    });

    let releaseHolder: () => void = () => undefined;
    const holder = withAgentStartLock(
      agentId,
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve;
        }),
    );
    await flushMicrotasks();

    releaseGate();
    await flushMicrotasks();
    expect(detachedStart).not.toHaveBeenCalled();

    releaseHolder();
    await expect(holder).resolves.toBeUndefined();
    await expect(detachedRun).resolves.toBe("detached");
    expect(detachedStart).toHaveBeenCalledTimes(1);
  });
});