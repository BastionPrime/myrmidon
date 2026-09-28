// myrmidon(D1): pure unit test for nextSweepCursor. See
// docs/myrmidon/DIVERGENCE.md.
import { describe, expect, it } from "vitest";
import { nextSweepCursor } from "./sweep-cursor.js";

type Row = { createdAt: string; id: string };

describe("nextSweepCursor", () => {
  it("advances to the last row of a full page", () => {
    const page: Row[] = [
      { createdAt: "2026-09-28T00:00:00Z", id: "a" },
      { createdAt: "2026-09-28T00:00:01Z", id: "b" },
    ];

    expect(nextSweepCursor(null, page)).toEqual(page[1]);
  });

  it("advances to the last row of a page shorter than the page size", () => {
    // This is the historical bug: the caller previously only kept a cursor
    // when the page came back full, resetting to the very start of the
    // table otherwise — turning every poll into a full-history rescan,
    // because a full page of real matches is rare.
    const current: Row = { createdAt: "2026-09-27T00:00:00Z", id: "old" };
    const page: Row[] = [{ createdAt: "2026-09-28T00:00:02Z", id: "c" }];

    expect(nextSweepCursor(current, page)).toEqual(page[0]);
  });

  it("keeps the current cursor when a page finds nothing, instead of resetting to the start", () => {
    const current: Row = { createdAt: "2026-09-27T00:00:00Z", id: "old" };

    expect(nextSweepCursor(current, [])).toEqual(current);
  });

  it("stays null when starting fresh and a page finds nothing", () => {
    expect(nextSweepCursor(null, [])).toBeNull();
  });
});
