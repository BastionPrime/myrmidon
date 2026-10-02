// server/src/myrmidon/evals/tasks/corpus.ts
//
// myrmidon(1.6-EVALS-B): the corpus registry and the loader Part B owns.
//
// One file per role corpus under tasks/ (v1-engineer.ts today), a shared
// versioning contract (corpus-versioning.ts), and this registry that maps a
// role to its corpus plus metadata. Part A's routes call `seedRole` /
// `corpusForRole` — the shapes match the seed draft's SeedReferenceTask, so
// Part A's `seedReferenceTasks(db, companyId, role, tasks)` consumes the
// loader output unchanged. This module adds no tables and no service
// changes: storage stays Part A's myrmidon_eval_reference_tasks, with the
// rubric in jsonb and the corpus version tracked in the data here.
//
// Baseline convention (Part B, first full run): subject
// `baseline-<role>-<corpusVersion>`; the run id is recorded on the board
// ticket and, once the judge contour is live, replayed through Part A's
// `POST .../evals/runs` API.

import type { VersionedReferenceTask } from "./corpus-versioning.js";
import { validateVersionedCorpus, latestCorpusVersion } from "./corpus-versioning.js";
import { ENGINEER_TASKS_V1 } from "./v1-engineer.js";

/** The pilot role of the 1.6 evals wave. */
export const EVALS_B_PILOT_ROLE = "engineer";

/** The shape the seeder consumes — identical to Part A's seed draft type. */
export interface SeedableReferenceTask {
  slug: string;
  title: string;
  prompt: string;
  kind: "general" | "code";
  weight: number;
  rubric: {
    criteria: {
      name: string;
      description: string;
      points: number;
    }[];
  };
}

export interface RoleCorpus {
  role: string;
  /** The tasks with their per-task version trail. */
  tasks: VersionedReferenceTask[];
  /** The newest corpus version present. */
  latestVersion: string | null;
  /** The subject string the first baseline run for this role must use. */
  baselineSubject: string | null;
}

const REGISTRY: Record<string, VersionedReferenceTask[]> = {
  [EVALS_B_PILOT_ROLE]: ENGINEER_TASKS_V1,
};

function validateRoleCorpus(role: string, tasks: readonly VersionedReferenceTask[]): void {
  const problem = validateVersionedCorpus(tasks);
  if (problem) {
    throw new Error(`corpus for role "${role}" is invalid: ${problem}`);
  }
  if (tasks.length < 20 || tasks.length > 50) {
    throw new Error(
      `corpus for role "${role}" has ${tasks.length} tasks; the reference set must be 20-50`,
    );
  }
}

/** All tasks of a role, sorted by slug for stable seeding and diffs. */
export function corpusForRole(role: string): RoleCorpus {
  const tasks = REGISTRY[role];
  if (!tasks) {
    throw new Error(`no reference corpus for role "${role}"`);
  }
  validateRoleCorpus(role, tasks);
  const sorted = [...tasks].sort((a, b) => a.slug.localeCompare(b.slug));
  const latest = latestCorpusVersion(sorted);
  return {
    role,
    tasks: sorted,
    latestVersion: latest,
    baselineSubject: latest ? `baseline-${role}-${latest}` : null,
  };
}

/** The seeder-ready task list (version fields stripped, rubric verbatim). */
export function seedableTasks(role: string): SeedableReferenceTask[] {
  return corpusForRole(role).tasks.map((t) => ({
    slug: t.slug,
    title: t.title,
    prompt: t.prompt,
    kind: t.kind,
    weight: t.weight,
    rubric: t.rubric,
  }));
}

/** The roles with a corpus registered (today: the pilot role only). */
export function corpusRoles(): string[] {
  return Object.keys(REGISTRY);
}

/** Exported for tests: the 20-50 bound on a reference corpus. */
export function assertReferenceSetSize(count: number): void {
  if (count < 20 || count > 50) {
    throw new Error(
      `a reference corpus must have 20-50 tasks; got ${count}`,
    );
  }
}
