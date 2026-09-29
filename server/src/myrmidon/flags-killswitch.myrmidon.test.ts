/**
 * Kill-switch flag semantics matrix (1.2, item 8: FLAGS-KILLSWITCH-TESTS).
 *
 * One place that pins the on/off semantics of every MYRMIDON_* kill switch
 * (L1-L5) against docs/myrmidon/FLAGS.md. Each flag is exercised for:
 *
 *  (a) unset  — the production default;
 *  (b) explicit off values ("0"/"false"/… or empty/"off", whichever applies);
 *  (c) explicit on values ("1"/"true"/… or a non-empty list for L1);
 *  (d) unrecognized values — the fail-safe convention: a typo must never
 *      silently flip a flag to its incident-rollback side (CONVENTIONS.md).
 *
 * L1 is list-valued (a code list, not a boolean), so it gets its own block.
 * L2 is the emergency flag: only the exact value "1" restores vendor
 * behavior. The guard test at the bottom fails when docs/myrmidon/FLAGS.md
 * loses a row, gains an undocumented row, or drops the L1-L5 level column.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_INFRA_INTERRUPT_ERROR_CODES,
  INFRA_INTERRUPT_CODES_ENV,
  readInfraInterruptCodes,
} from "./infra-interrupts.js";
import { settledHoldsBlockExplicitWakes } from "./settled-holds/config.js";
import { PAUSE_DRAINS_ENV, readPauseDrainsEnabled } from "./pause-drain.js";
import {
  STRANDED_AUTO_POLICY_ENABLED_ENV,
  readStrandedAutoPolicyEnabled,
} from "./stranded-autopolicy.js";
import {
  WRITE_LOCK_REQUIRES_LIVE_RUN_ENV,
  isWriteLockLiveRunCheckEnabled,
} from "./issue-write-run-lock.js";

const FLAGS_MD_PATH = fileURLToPath(new URL("../../../docs/myrmidon/FLAGS.md", import.meta.url));

/**
 * Boolean kill switches (L2-L5). L1 (list-valued) is pinned in the
 * describe("L1 …") block below. Rows here mirror docs/myrmidon/FLAGS.md.
 */
const BOOLEAN_FLAGS = [
  {
    env: "MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES",
    level: "L2",
    read: () => settledHoldsBlockExplicitWakes(),
    /** Unset is OUR behavior: the emergency (vendor) mode is opt-in only. */
    unsetExpected: false,
    offValues: [undefined, "0", "false", "no", "off", "", "  "],
    /** Emergency rollback needs the exact "1" — nothing else. */
    onValues: ["1"],
    /** Fail-safe side for typos: OFF (vendor mode requires an exact "1"). */
    typo: { values: ["true", "yes", "on", "case", " 1", "1 "], expected: false },
  },
  {
    env: PAUSE_DRAINS_ENV,
    level: "L3",
    read: () => readPauseDrainsEnabled(),
    unsetExpected: true,
    offValues: ["0", "false", "no", "off", "OFF", " Off "],
    onValues: [undefined, "1", "true", "yes", "on", "", "  "],
    /** Fail-safe side for typos: ON (a typo must not cancel active runs). */
    typo: { values: ["case", "maybe"], expected: true },
  },
  {
    env: STRANDED_AUTO_POLICY_ENABLED_ENV,
    level: "L4",
    read: () => readStrandedAutoPolicyEnabled(),
    unsetExpected: true,
    offValues: ["false", "0", "FALSE", " 0 "],
    onValues: [undefined, "true", "1", "yes", "on", "", "  "],
    /** Fail-safe side for typos: ON ("a typo cannot silently disable the fix"). */
    typo: { values: ["case", "flase", "tru"], expected: true },
  },
  {
    env: WRITE_LOCK_REQUIRES_LIVE_RUN_ENV,
    level: "L5",
    read: () => isWriteLockLiveRunCheckEnabled(),
    unsetExpected: true,
    offValues: ["0", "false", "FALSE", " 0 "],
    onValues: [undefined, "1", "true", "yes", "on", "", "  "],
    /** Fail-safe side for typos: ON (anything but an explicit 0/false). */
    typo: { values: ["case", "maybe", "NO"], expected: true },
  },
] as const;

/** Every env key this suite owns, including the list-valued L1 flag. */
const ENV_KEYS = [INFRA_INTERRUPT_CODES_ENV, ...BOOLEAN_FLAGS.map((row) => row.env)];

describe("kill-switch flag semantics (L1-L5, docs/myrmidon/FLAGS.md)", () => {
  // Vitest runs the suite in one process and every reader defaults to
  // process.env: snapshot and clear all owned keys before each test, and
  // restore after, so flags never leak between tests or into other suites.
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("L1 MYRMIDON_INFRA_INTERRUPT_CODES (list-valued)", () => {
    it("unset: the documented default code list (the fix is on)", () => {
      expect(readInfraInterruptCodes()).toEqual(new Set(DEFAULT_INFRA_INTERRUPT_ERROR_CODES));
    });

    it("empty or \"off\" (any case, padded): empty set — vendor behavior, the hold always locks", () => {
      for (const raw of ["", "  ", "off", "OFF", " Off "]) {
        process.env[INFRA_INTERRUPT_CODES_ENV] = raw;
        expect(readInfraInterruptCodes(), `L1 raw=${JSON.stringify(raw)}`).toEqual(new Set());
      }
    });

    it("a non-empty value is the custom code list — trim, drop empties", () => {
      process.env[INFRA_INTERRUPT_CODES_ENV] = " agent_paused ,, process_lost ,";
      expect(readInfraInterruptCodes()).toEqual(new Set(["agent_paused", "process_lost"]));
    });

    it("the custom list replaces the default set entirely (no merge): a listed-only code set forgets the unlisted defaults", () => {
      process.env[INFRA_INTERRUPT_CODES_ENV] = "agent_paused";
      const codes = readInfraInterruptCodes();
      expect(codes.has("agent_paused")).toBe(true);
      expect(codes.has("process_lost")).toBe(false);
    });
  });

  for (const flag of BOOLEAN_FLAGS) {
    describe(`${flag.level} ${flag.env}`, () => {
      it("unset: the production default (documented in FLAGS.md)", () => {
        expect(flag.read()).toBe(flag.unsetExpected);
      });

      it("each documented off value turns the flag off (vendor behavior restored)", () => {
        for (const value of flag.offValues) {
          if (value === undefined) delete process.env[flag.env];
          else process.env[flag.env] = value;
          expect(flag.read(), `${flag.env}=${JSON.stringify(value)} should be OFF`).toBe(false);
        }
      });

      it("each documented on value turns the flag on (our behavior)", () => {
        for (const value of flag.onValues) {
          if (value === undefined) delete process.env[flag.env];
          else process.env[flag.env] = value;
          expect(flag.read(), `${flag.env}=${JSON.stringify(value)} should be ON`).toBe(true);
        }
      });

      it("unrecognized values stay on the fail-safe side (a typo never flips the flag silently)", () => {
        for (const value of flag.typo.values) {
          process.env[flag.env] = value;
          expect(
            flag.read(),
            `${flag.env}=${JSON.stringify(value)} should stay ${flag.typo.expected ? "ON" : "OFF"}`,
          ).toBe(flag.typo.expected);
        }
      });
    });
  }

  it("L2 emergency flag: only the exact \"1\" restores vendor behavior — \"true\"/\"yes\"/\"on\" do not", () => {
    process.env["MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES"] = "1";
    expect(settledHoldsBlockExplicitWakes()).toBe(true);
    for (const value of ["true", "yes", "on", "case", " 1", "1 ", "1x", "01"]) {
      process.env["MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES"] = value;
      expect(
        settledHoldsBlockExplicitWakes(),
        `only "1" may enable vendor mode; ${JSON.stringify(value)} must not`,
      ).toBe(false);
    }
  });
});

describe("docs/myrmidon/FLAGS.md guard", () => {
  const flagsMd = readFileSync(FLAGS_MD_PATH, "utf8");
  // Rows look like "| `MYRMIDON_X` | L1 | on | off | unset | typo |": split on
  // the outer pipes, trim each cell, strip one pair of code ticks around a
  // cell, then drop the leading empty cell the leading pipe always produces.
  // After that: cells[0]=name, [1]=level, [2]=on, [3]=off, [4]=unset, [5]=typo.
  const tableRows = flagsMd
    .split("\n")
    .filter((line) => line.startsWith("| `MYRMIDON_"))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .map((cell) => cell.replace(/^`([^`]*)`$/, "$1")),
    )
    .map((cells) => cells.slice(1));

  /** Name cell of each row with the code ticks stripped: `MYRMIDON_X` -> MYRMIDON_X. */
  const documentedEnvKeys = tableRows.map((cells) => cells[0]);

  it("documents exactly the kill switches this suite pins (no lost, no undocumented rows)", () => {
    expect(new Set(documentedEnvKeys)).toEqual(new Set(ENV_KEYS));
  });

  it("every row carries its L1-L5 level and both semantic cells", () => {
    for (const cells of tableRows) {
      expect(cells.length, `row ${cells[0]} must have all columns`).toBeGreaterThanOrEqual(6);
      expect(cells[1], `row ${cells[0]} must name its L-level`).toMatch(/^L[1-5]$/);
      expect(cells[2], `row ${cells[0]} must describe the ON side`).toBeTruthy();
      expect(cells[3], `row ${cells[0]} must describe the OFF side`).toBeTruthy();
      expect(cells[4], `row ${cells[0]} must describe the unset default`).toBeTruthy();
    }
  });
});

describe("myrmidon env coverage guard (code vs docs)", () => {
  // Every MYRMIDON_* environment name that server/src/myrmidon actually reads
  // must be documented somewhere: docs/myrmidon/FLAGS.md (a kill switch with an
  // L1-L5 semantics row, checked by the guard above), docs/myrmidon/SETTINGS.md
  // (an ordinary setting), or the explicit list below (run-admission limits
  // documented in docs/myrmidon/ROADMAP.md, item C0 — numeric limits, not kill
  // switches). A brand-new flag nobody classified makes this test red: add it to
  // FLAGS.md if it is a kill switch, to SETTINGS.md if it is a setting.
  const DOCUMENTED_IN_ROADMAP_C0 = new Set([
    "MYRMIDON_MAX_CONCURRENT_RUNS",
    "MYRMIDON_MAX_RUN_STARTS_PER_MINUTE",
    "MYRMIDON_MIN_FREE_MEMORY_MB",
    "MYRMIDON_RUN_MEMORY_ESTIMATE_MB",
  ]);

  function listNonTestTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listNonTestTsFiles(full));
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        out.push(full);
      }
    }
    return out;
  }

  it("every MYRMIDON_* env name read by myrmidon code is documented (FLAGS.md / SETTINGS.md / ROADMAP C0)", () => {
    const myrmidonDir = fileURLToPath(new URL("./", import.meta.url));
    const seen = new Set<string>();
    for (const file of listNonTestTsFiles(myrmidonDir)) {
      for (const match of readFileSync(file, "utf8").matchAll(/MYRMIDON_[A-Z0-9_]+/g)) {
        const name = match[0];
        // Trailing-underscore hits are comment prefixes (MYRMIDON_BOT_*,
        // MYRMIDON_MAINTENANCE_*); MYRMIDON_MCP_TOKEN_<server> variables are
        // generated per bot profile from MYRMIDON_BOT_MCP_SERVERS, not settings.
        if (name.endsWith("_")) continue;
        if (name.startsWith("MYRMIDON_MCP_TOKEN_")) continue;
        seen.add(name);
      }
    }

    const settingsMd = readFileSync(
      fileURLToPath(new URL("../../../docs/myrmidon/SETTINGS.md", import.meta.url)),
      "utf8",
    );
    const settingsNames = new Set<string>();
    for (const match of settingsMd.matchAll(/`MYRMIDON_[A-Z0-9_]+`/g)) {
      settingsNames.add(match[0].slice(1, -1));
    }

    const flagsMd = readFileSync(FLAGS_MD_PATH, "utf8");
    const flagNames = new Set<string>();
    for (const match of flagsMd.matchAll(/^\| `MYRMIDON_[A-Z0-9_]+`/gm)) {
      flagNames.add(match[0].slice(2, -1));
    }

    const undocumented = [...seen]
      .filter(
        (name) =>
          !flagNames.has(name) &&
          !settingsNames.has(name) &&
          !DOCUMENTED_IN_ROADMAP_C0.has(name),
      )
      .sort();
    expect(
      undocumented,
      "new MYRMIDON_* env name(s) read by myrmidon code: classify each in docs/myrmidon/FLAGS.md (kill switch) or docs/myrmidon/SETTINGS.md (setting)",
    ).toEqual([]);
  });
});
