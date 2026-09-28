// myrmidon(D1): pure unit tests for nextSweepCursor and shouldForceFullSweep.
// See docs/myrmidon/DIVERGENCE.md.
import { describe, expect, it } from "vitest";
import { nextSweepCursor, shouldForceFullSweep } from "./sweep-cursor.js";

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
    // A page with any matches makes forward progress even if it did not
    // fill the requested limit — a full page of real matches is rare (see
    // this function's own doc comment), so waiting for one would mean
    // almost never advancing.
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

describe("shouldForceFullSweep", () => {
  it("is true the first time, before any full sweep has happened", () => {
    expect(shouldForceFullSweep(null, Date.now(), 60_000)).toBe(true);
  });

  it("is false right after a full sweep", () => {
    const now = Date.now();
    expect(shouldForceFullSweep(now, now, 60_000)).toBe(false);
    expect(shouldForceFullSweep(now, now + 59_999, 60_000)).toBe(false);
  });

  it("is true once the interval has fully elapsed", () => {
    const now = Date.now();
    expect(shouldForceFullSweep(now, now + 60_000, 60_000)).toBe(true);
    expect(shouldForceFullSweep(now, now + 120_000, 60_000)).toBe(true);
  });
});

describe("nextSweepCursor + shouldForceFullSweep together (out-of-order eligibility)", () => {
  // This is the scenario nextSweepCursor's cursor alone gets wrong: two
  // chat_actions rows, A created before B, but B's owner reaches a terminal
  // status first (plausible under the system's 12-lane run concurrency —
  // see nextSweepCursor's doc comment). A single ever-advancing keyset
  // cursor would sweep B, advance past A's created_at, and then exclude A
  // forever. shouldForceFullSweep bounds that to "until the next full
  // sweep", not "forever".
  const rowA: Row = { createdAt: "2026-09-28T00:00:00Z", id: "a-older-pending-owner" };
  const rowB: Row = { createdAt: "2026-09-28T00:00:05Z", id: "b-newer-resolved-first" };

  it("a keyset-only sweep would permanently exclude the older, later-resolving row", () => {
    // Call 1: only B is eligible yet (A's owner hasn't gone terminal).
    let cursor: Row | null = null;
    cursor = nextSweepCursor(cursor, [rowB]);
    expect(cursor).toEqual(rowB);

    // Call 2: A's owner has now gone terminal, but a plain keyset predicate
    // `(created_at, id) > cursor` with cursor = rowB excludes rowA, whose
    // created_at is earlier. Simulating the query's filter directly:
    const keysetIncludesRowA =
      rowA.createdAt > cursor.createdAt ||
      (rowA.createdAt === cursor.createdAt && rowA.id > cursor.id);
    expect(keysetIncludesRowA).toBe(false); // the bug this PR fixes
  });

  it("a periodic forced full sweep still finds the older row once its owner resolves", () => {
    let cursor: Row | null = null;
    let lastFullSweepAt: number | null = null;
    const intervalMs = 60_000;
    let now = 0;

    // Call 1 (t=0): forced (first call ever), only B eligible so far.
    expect(shouldForceFullSweep(lastFullSweepAt, now, intervalMs)).toBe(true);
    lastFullSweepAt = now;
    cursor = nextSweepCursor(cursor, [rowB]);
    expect(cursor).toEqual(rowB);

    // Call 2 (t=30s): not yet due for another forced sweep. A's owner
    // resolves now, but the keyset-only page can't see it (cursor is past
    // rowA's created_at) — nothing new comes back.
    now = 30_000;
    expect(shouldForceFullSweep(lastFullSweepAt, now, intervalMs)).toBe(false);
    cursor = nextSweepCursor(cursor, []);
    expect(cursor).toEqual(rowB);

    // Call 3 (t=65s): the interval has elapsed, so this call ignores the
    // cursor and scans from the start — rowA (now eligible) is found.
    now = 65_000;
    expect(shouldForceFullSweep(lastFullSweepAt, now, intervalMs)).toBe(true);
    lastFullSweepAt = now;
    const forcedPage = [rowA]; // start-of-table scan finds the straggler
    cursor = nextSweepCursor(null, forcedPage);
    expect(cursor).toEqual(rowA);
  });
});
