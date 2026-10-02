import { describe, expect, it } from "vitest";
import { resolveStatusOnResume } from "../myrmidon/pause-drain.js";

// Minimal stand-in for the drizzle select chain: select().from().where() -> rows.
function fakeDb(count: number | null) {
  const rows = count === null ? [] : [{ count }];
  const chain = { from: () => chain, where: () => Promise.resolve(rows) };
  return { select: () => chain } as unknown as Parameters<typeof resolveStatusOnResume>[0];
}

describe("resolveStatusOnResume (L3c)", () => {
  it("keeps the agent running when a run left over from a drained pause is still running", async () => {
    await expect(resolveStatusOnResume(fakeDb(1), "agent")).resolves.toBe("running");
    await expect(resolveStatusOnResume(fakeDb(3), "agent")).resolves.toBe("running");
  });

  it("goes idle when nothing is running", async () => {
    await expect(resolveStatusOnResume(fakeDb(0), "agent")).resolves.toBe("idle");
    await expect(resolveStatusOnResume(fakeDb(null), "agent")).resolves.toBe("idle");
  });
});
