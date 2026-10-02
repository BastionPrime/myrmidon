// server/src/myrmidon/evals/tasks/corpus-versioning.ts
//
// myrmidon(1.6-EVALS-B): versioning rules for the reference-task corpus.
//
// The corpus is data owned by Part B (the reference-task set, rubrics,
// storage/versioning). Part A owns the judge, the run service and the routes;
// this module intentionally adds no tables and no service changes: the
// rubric lives in jsonb, so a rubric edit is a data change, not a migration.
//
// Versioning contract:
// - Every corpus release carries a `corpusVersion` (semver: MAJOR.MINOR.PATCH).
// - MAJOR: a task was removed, or a rubric criterion was renamed/removed, or
//   a weight dropped. Scores are NOT comparable across a MAJOR bump; a new
//   baseline run is required after the change.
// - MINOR: tasks were added. Old scores stay comparable (new tasks only add
//   mass), but a fresh baseline is recommended.
// - PATCH: prompt/rubric wording tightened without changing criterion names
//   or points. Scores remain comparable.
// - Every change to a task records a `changeNote` on the next corpus entry,
//   so `GET .../evals/tasks` can answer "what changed and when" from data.
//
// The version is recorded on the run by Part A's service (model field family);
// the corpus side exports it for the seeder and for tests.

/** The corpus entry: a task plus the version it last changed in. */
export interface VersionedReferenceTask {
  /** Semantic version of the corpus release this task's current form belongs to. */
  corpusVersion: string;
  /** Free-text note: what changed for this task at that version. */
  changeNote: string;
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

export const CORPUS_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function isCorpusVersion(value: unknown): value is string {
  return typeof value === "string" && CORPUS_VERSION_PATTERN.test(value);
}

/** Compare two semver strings (only MAJOR.MINOR.PATCH, no pre-release). */
export function compareCorpusVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when two corpus versions are score-comparable (same MAJOR, no task removal). */
export function versionsComparable(a: string, b: string): boolean {
  return a.split(".")[0] === b.split(".")[0];
}

/**
 * Validate a corpus list as a whole: unique slugs, valid versions, valid
 * weights and rubrics, and a monotonically consistent changeNote trail.
 * Returns the first problem found, or null when the corpus is well-formed.
 */
export function validateVersionedCorpus(
  tasks: readonly VersionedReferenceTask[],
): string | null {
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!t.slug) return "empty slug";
    if (seen.has(t.slug)) return `duplicate slug: ${t.slug}`;
    seen.add(t.slug);
    if (!isCorpusVersion(t.corpusVersion)) return `bad corpusVersion for ${t.slug}`;
    if (!t.changeNote || t.changeNote.length < 3) return `missing changeNote for ${t.slug}`;
    if (t.kind !== "general" && t.kind !== "code") return `bad kind for ${t.slug}`;
    if (!Number.isInteger(t.weight) || t.weight < 1 || t.weight > 5) {
      return `bad weight for ${t.slug}`;
    }
    const criteria = t.rubric?.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) return `empty rubric for ${t.slug}`;
    for (const c of criteria) {
      if (typeof c?.name !== "string" || !c.name) return `bad criterion name in ${t.slug}`;
      if (typeof c.description !== "string" || c.description.length < 5) {
        return `criterion ${c.name} in ${t.slug} has no description`;
      }
      if (typeof c.points !== "number" || !Number.isFinite(c.points) || c.points <= 0) {
        return `criterion ${c.name} in ${t.slug} has non-positive points`;
      }
    }
  }
  return null;
}

/** The distinct corpus versions present, sorted ascending. */
export function corpusVersions(tasks: readonly VersionedReferenceTask[]): string[] {
  const set = new Set(tasks.map((t) => t.corpusVersion));
  return [...set].sort(compareCorpusVersions);
}

/** The newest corpus version present (max), or null for an empty list. */
export function latestCorpusVersion(tasks: readonly VersionedReferenceTask[]): string | null {
  const versions = corpusVersions(tasks);
  return versions.length > 0 ? versions[versions.length - 1]! : null;
}
