// server/src/myrmidon/evals/tasks/index.ts
//
// myrmidon(1.6-EVALS-B): the Part B entry point of the corpus modules.
//
// The corpus registry (corpus.ts) + the versioned corpora (v1-engineer.ts)
// + the versioning rules (corpus-versioning.ts) re-exported so Part A and
// the routes import one module. No database, no Express: this half is pure
// data plus its validators.

export {
  CORPUS_VERSION_PATTERN,
  compareCorpusVersions,
  corpusVersions,
  isCorpusVersion,
  latestCorpusVersion,
  validateVersionedCorpus,
  versionsComparable,
  type VersionedReferenceTask,
} from "./corpus-versioning.js";

export {
  EVALS_B_PILOT_ROLE,
  assertReferenceSetSize,
  corpusForRole,
  corpusRoles,
  seedableTasks,
  type RoleCorpus,
  type SeedableReferenceTask,
} from "./corpus.js";

export { ENGINEER_TASKS_V1 } from "./v1-engineer.js";
