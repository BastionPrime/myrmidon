import { describe, expect, it } from "vitest";
import { createBotKeyLock } from "./bot-key-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createBotKeyLock", () => {
  it("runs calls for the same bot one after another, never overlapping", async () => {
    const lock = createBotKeyLock();
    const events: string[] = [];
    const first = deferred();
    const a = lock.run("agent-a", async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
      return 1;
    });
    const b = lock.run("agent-a", async () => {
      events.push("second:start");
      return 2;
    });
    await flush();
    expect(events).toEqual(["first:start"]); // the second waits
    first.resolve();
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not serialize different bots", async () => {
    const lock = createBotKeyLock();
    const gate = deferred();
    const events: string[] = [];
    const slow = lock.run("agent-a", async () => {
      await gate.promise;
      events.push("a");
    });
    await lock.run("agent-b", async () => {
      events.push("b");
    });
    expect(events).toEqual(["b"]);
    gate.resolve();
    await slow;
  });

  it("a rejected call is reported to its own caller and does not block the next one", async () => {
    const lock = createBotKeyLock();
    const failing = lock.run("agent-a", async () => {
      throw new Error("boom");
    });
    const next = lock.run("agent-a", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("forgets a bot once its queue is empty (no unbounded growth across bots)", async () => {
    const lock = createBotKeyLock();
    await lock.run("agent-a", async () => undefined);
    await lock.run("agent-b", async () => undefined);
    await flush();
    expect(lock.size()).toBe(0);
  });
});
