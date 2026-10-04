// myrmidon(1.6-GRD): GUARDRAILS reference corpus — neutral synthetic fixtures.
//
// Data-only module: JSON case files under this directory plus a loader with
// runtime schema validation. Every case is synthetic — documented provider
// test/example key shapes (AWS docs, GitHub docs examples, public test card
// numbers), reserved documentation domains (example.com, 192.0.2.0/24,
// +1-555-01xx), and checksum-correct synthetic INN/SNILS values. No real
// secrets or personal data are included.
//
// Consumers (detector parts A and B) import the corpus after this PR merges
// and assert their detectors against `expect.detector`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Categories a corpus case can carry. */
export const CORPUS_CATEGORIES = [
  "secret",
  "pii",
  "injection",
  "benign",
] as const;

/** Detector a case expects to fire (`null` = no detector should fire). */
export const CORPUS_DETECTORS = ["secret", "pii", "injection"] as const;

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];
export type CorpusDetector = (typeof CORPUS_DETECTORS)[number];

export interface CorpusCase {
  id: string;
  category: CorpusCategory;
  subtype: string;
  text: string;
  expect: { detector: CorpusDetector | null };
}

export class CorpusValidationError extends Error {
  constructor(message: string) {
    super(`GUARDRAILS corpus validation failed: ${message}`);
    this.name = "CorpusValidationError";
  }
}

const CATEGORY_SET = new Set<string>(CORPUS_CATEGORIES);
const DETECTOR_SET = new Set<string>(CORPUS_DETECTORS);

/** JSON files shipped next to this module, mapped category -> file name. */
const FILES: ReadonlyArray<readonly [CorpusCategory, string]> = [
  ["secret", "corpus-secret.json"],
  ["pii", "corpus-pii.json"],
  ["injection", "corpus-injection.json"],
  ["benign", "corpus-benign.json"],
];

function isCorpusCase(value: unknown): value is CorpusCase {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.subtype === "string" &&
    typeof c.text === "string"
  );
}

/**
 * Validate a parsed array of raw cases: unique ids, allowed categories and
 * detectors, non-empty text, and expect consistent with the category
 * (benign must expect no detector, the other three must expect themselves).
 * Returns the typed cases; throws CorpusValidationError on the first problem.
 */
export function validateCorpusCases(
  raw: ReadonlyArray<unknown>,
  source: string,
): CorpusCase[] {
  const seen = new Set<string>();
  const out: CorpusCase[] = [];
  for (const item of raw) {
    if (!isCorpusCase(item)) {
      throw new CorpusValidationError(`${source}: entry is not a corpus case`);
    }
    const { id, subtype, text } = item;
    const rawItem = item as unknown as Record<string, unknown>;
    const category = rawItem.category;
    const expect = rawItem.expect as
      | { detector?: unknown }
      | undefined;
    if (!id.trim()) {
      throw new CorpusValidationError(`${source}: empty id`);
    }
    if (seen.has(id)) {
      throw new CorpusValidationError(`${source}: duplicate id ${id}`);
    }
    if (typeof category !== "string" || !CATEGORY_SET.has(category)) {
      throw new CorpusValidationError(
        `${source}: case ${id} has unknown category ${String(category)}`,
      );
    }
    if (typeof subtype !== "string" || !subtype.trim()) {
      throw new CorpusValidationError(`${source}: case ${id} has empty subtype`);
    }
    if (!text.trim()) {
      throw new CorpusValidationError(`${source}: case ${id} has empty text`);
    }
    if (typeof expect !== "object" || expect === null) {
      throw new CorpusValidationError(
        `${source}: case ${id} has no expect object`,
      );
    }
    const detector = expect.detector;
    const validDetector =
      detector === null ||
      (typeof detector === "string" && DETECTOR_SET.has(detector));
    if (!validDetector) {
      throw new CorpusValidationError(
        `${source}: case ${id} has unknown expect.detector ${String(detector)}`,
      );
    }
    const categoryTyped = category as CorpusCategory;
    const expectedDetector =
      categoryTyped === "benign" ? null : (categoryTyped as CorpusDetector);
    if (detector !== expectedDetector) {
      throw new CorpusValidationError(
        `${source}: case ${id} category ${category} must expect detector ` +
          `${String(expectedDetector)}, got ${String(detector)}`,
      );
    }
    seen.add(id);
    out.push({
      id,
      category: categoryTyped,
      subtype,
      text,
      expect: { detector: detector === null ? null : (detector as CorpusDetector) },
    });
  }
  return out;
}

/**
 * Load all corpus files from disk and validate them. Memoized per process.
 * Throws CorpusValidationError on any schema violation.
 */
export function loadCorpus(): CorpusCase[] {
  if (cache) {
    return cache.slice();
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const cases: CorpusCase[] = [];
  for (const [category, file] of FILES) {
    const text = readFileSync(join(dir, file), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      throw new CorpusValidationError(`${file}: root is not an array`);
    }
    for (const c of validateCorpusCases(parsed, file)) {
      if (c.category !== category) {
        throw new CorpusValidationError(
          `${file}: case ${c.id} has category ${c.category}, file declares ${category}`,
        );
      }
      cases.push(c);
    }
  }
  cache = cases;
  return cases.slice();
}

let cache: CorpusCase[] | null = null;

/** Drop the memoized corpus (test helper). */
export function resetCorpusCache(): void {
  cache = null;
}
