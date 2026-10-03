// myrmidon(STALE-BLOCK): wiring guard. The sweep must be reachable from the
// server entry point: one import behind the STALE-BLOCK marker and one call
// site in the scheduler tick. This suite is red when the module is missing or
// the entry point lost its wiring (the "guard test is red without the sweep
// module" acceptance case).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStaleBlockScheduler } from "./index.js";
import { STALE_BLOCK_ACTIVITY_ACTOR, STALE_BLOCK_ACTIVITY_ACTION } from "./sweep.js";
import { STALE_BLOCK_ENABLED_ENV, STALE_BLOCK_INTERVAL_SEC_ENV } from "./settings.js";

const INDEX_TS = fileURLToPath(new URL("../../../src/index.ts", import.meta.url));

describe("stale block wiring guard", () => {
  it("the server entry point imports the module behind the STALE-BLOCK marker", () => {
    const source = readFileSync(INDEX_TS, "utf8");
    const importLines = source.split("\n").filter((line: string) => line.includes("stale-block"));
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines.every((line) => line.includes("myrmidon(STALE-BLOCK)"))).toBe(true);
  });

  it("the scheduler tick calls the stale-block pass in both tick paths", () => {
    const source = readFileSync(INDEX_TS, "utf8");
    const callSites = source.split("\n").filter((line: string) => /scheduleStaleBlockSweep\(\)/.test(line));
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    expect(callSites.every((line) => line.includes("myrmidon(STALE-BLOCK)"))).toBe(true);
    expect(source).toMatch(/myrmidon\(STALE-BLOCK\):[\s\S]{0,400}const scheduleStaleBlockSweep = createStaleBlockScheduler/);
  });

  it("both settings are documented in SETTINGS.md and SETTINGS.ru.md", () => {
    for (const doc of ["docs/myrmidon/SETTINGS.md", "docs/myrmidon/SETTINGS.ru.md"]) {
      const text = readFileSync(fileURLToPath(new URL(`../../../../${doc}`, import.meta.url)), "utf8");
      expect(text, `${doc} must document the enable flag`).toContain(STALE_BLOCK_ENABLED_ENV);
      expect(text, `${doc} must document the interval`).toContain(STALE_BLOCK_INTERVAL_SEC_ENV);
    }
  });

  it("the sweep is exported and constructable with an injected event seam", () => {
    expect(typeof createStaleBlockScheduler).toBe("function");
    const calls: string[] = [];
    const tick = createStaleBlockScheduler({
      // A bare in-memory stand-in: the scheduler only needs `track`.
      db: {} as never,
      track: (work) => {
        void work;
        calls.push("tracked");
      },
      env: {},
    });
    expect(typeof tick).toBe("function");
  });

  it("constants are stable: one activity actor and action, marker-owned", () => {
    expect(STALE_BLOCK_ACTIVITY_ACTOR).toBe("stale_block_sweep");
    expect(STALE_BLOCK_ACTIVITY_ACTION).toBe("myrmidon.stale_block.unblocked");
  });
});
