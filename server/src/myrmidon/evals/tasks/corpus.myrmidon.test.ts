import { describe, expect, it } from "vitest";

import {
  compareCorpusVersions,
  isCorpusVersion,
  latestCorpusVersion,
  validateVersionedCorpus,
  versionsComparable,
  type VersionedReferenceTask,
} from "./corpus-versioning.js";
import {
  EVALS_B_PILOT_ROLE,
  assertReferenceSetSize,
  corpusForRole,
  corpusRoles,
  seedableTasks,
} from "./corpus.js";
import { ENGINEER_TASKS_V1 } from "./v1-engineer.js";

// myrmidon(1.6-EVALS-B): the reference-task corpus and its versioning rules.
// Part B owns the corpus (tasks, rubrics, storage/versioning); the corpus is
// data the judge scores answers against, so a malformed entry silently breaks
// a whole run — these tests keep the corpus load-bearing.

function neutralCorpusTasks(): VersionedReferenceTask[] {
  return [
    {
      corpusVersion: "1.0.0",
      changeNote: "initial release",
      slug: "neutral-task",
      title: "Neutral task",
      prompt: "Describe how you verify a fix for example.com/api/v1/items.",
      kind: "general",
      weight: 1,
      rubric: {
        criteria: [
          { name: "verdict", description: "The answer states a checkable outcome.", points: 3 },
          { name: "steps", description: "The answer lists ordered steps.", points: 3 },
        ],
      },
    },
  ];
}

describe("corpus versioning", () => {
  it("recognizes semver corpus versions", () => {
    expect(isCorpusVersion("1.0.0")).toBe(true);
    expect(isCorpusVersion("10.20.30")).toBe(true);
    expect(isCorpusVersion("1.0")).toBe(false);
    expect(isCorpusVersion("v1.0.0")).toBe(false);
    expect(isCorpusVersion(1)).toBe(false);
  });

  it("compares versions by major, minor, patch", () => {
    expect(compareCorpusVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareCorpusVersions("1.1.0", "1.0.9")).toBeGreaterThan(0);
    expect(compareCorpusVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareCorpusVersions("1.0.1", "1.0.10")).toBeLessThan(0);
  });

  it("treats versions within one major as score-comparable", () => {
    expect(versionsComparable("1.2.0", "1.9.0")).toBe(true);
    expect(versionsComparable("2.0.0", "1.9.0")).toBe(false);
  });

  it("accepts a well-formed versioned corpus", () => {
    expect(validateVersionedCorpus(neutralCorpusTasks())).toBeNull();
    expect(latestCorpusVersion(neutralCorpusTasks())).toBe("1.0.0");
  });

  it("rejects duplicate slugs", () => {
    const tasks = [...neutralCorpusTasks(), ...neutralCorpusTasks()];
    expect(validateVersionedCorpus(tasks)).toContain("duplicate slug");
  });

  it("rejects a missing changeNote", () => {
    const tasks = neutralCorpusTasks();
    (tasks[0] as { changeNote: string }).changeNote = "";
    expect(validateVersionedCorpus(tasks)).toContain("missing changeNote");
  });

  it("rejects a bad weight", () => {
    const tasks = neutralCorpusTasks();
    (tasks[0] as { weight: number }).weight = 0;
    expect(validateVersionedCorpus(tasks)).toContain("bad weight");
  });

  it("rejects non-positive criterion points", () => {
    const tasks = neutralCorpusTasks();
    tasks[0]!.rubric.criteria[0]!.points = 0;
    expect(validateVersionedCorpus(tasks)).toContain("non-positive points");
  });
});

describe("engineer reference corpus", () => {
  const corpus = corpusForRole(EVALS_B_PILOT_ROLE);

  it("is the only registered role", () => {
    expect(corpusRoles()).toEqual([EVALS_B_PILOT_ROLE]);
  });

  it("has 20-50 tasks (the epic's bound)", () => {
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(20);
    expect(corpus.tasks.length).toBeLessThanOrEqual(50);
    expect(corpus.tasks.length).toBe(ENGINEER_TASKS_V1.length);
  });

  it("passes whole-corpus validation", () => {
    expect(validateVersionedCorpus(corpus.tasks)).toBeNull();
  });

  it("sorts tasks by slug and keeps them unique", () => {
    const slugs = corpus.tasks.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual([...slugs].sort((a, b) => a.localeCompare(b)));
  });

  it("carries a version trail with at least the initial release and the 1.1.0 addition", () => {
    const versions = new Set(corpus.tasks.map((t) => t.corpusVersion));
    expect(versions.has("1.0.0")).toBe(true);
    expect(versions.has("1.1.0")).toBe(true);
    expect(latestCorpusVersion(corpus.tasks)).toBe("1.1.0");
  });

  it("reports the baseline subject for the pilot role", () => {
    expect(corpus.latestVersion).toBe("1.1.0");
    expect(corpus.baselineSubject).toBe("baseline-engineer-1.1.0");
  });

  it("mixes general and code tasks (code tasks take a CI pass rate later)", () => {
    const kinds = new Set(corpus.tasks.map((t) => t.kind));
    expect(kinds.has("general")).toBe(true);
    expect(kinds.has("code")).toBe(true);
  });

  it("keeps weights in 1..5 and criterion points positive", () => {
    for (const t of corpus.tasks) {
      expect(t.weight).toBeGreaterThanOrEqual(1);
      expect(t.weight).toBeLessThanOrEqual(5);
      expect(t.rubric.criteria.length).toBeGreaterThanOrEqual(2);
      for (const c of t.rubric.criteria) {
        expect(c.points).toBeGreaterThan(0);
        expect(c.description.length).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("keeps every rubric criterion name unique within its task (judge keys on names)", () => {
    for (const t of corpus.tasks) {
      const names = t.rubric.criteria.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("produces the seeder-ready list without version fields", () => {
    const seedable = seedableTasks(EVALS_B_PILOT_ROLE);
    expect(seedable).toHaveLength(corpus.tasks.length);
    for (const t of seedable) {
      expect(t.slug).toBeTruthy();
      expect(t.prompt.length).toBeGreaterThan(40);
      expect(t.rubric.criteria.length).toBeGreaterThan(0);
    }
    expect(seedable[0]).not.toHaveProperty("corpusVersion");
  });

  it("rejects an unknown role", () => {
    expect(() => corpusForRole("designer")).toThrow(/no reference corpus/);
  });

  it("rejects a corpus outside the 20-50 bound", () => {
    // Red/green proof of the bound: 1 well-formed task is a valid corpus
    // structurally, but the loader must refuse it as a reference set.
    expect(() => assertReferenceSetSize(1)).toThrow(/20-50/);
    expect(() => assertReferenceSetSize(neutralCorpusTasks().length)).toThrow(/20-50/);
    expect(() => assertReferenceSetSize(20)).not.toThrow();
    expect(() => assertReferenceSetSize(50)).not.toThrow();
    expect(() => assertReferenceSetSize(51)).toThrow(/20-50/);
  });
});
