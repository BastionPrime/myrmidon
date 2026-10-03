// server/src/myrmidon/guardrails/detect.ts
//
// myrmidon(1.6-GRD): pattern-oriented leak detectors for the output of runs.
//
// This module is pure: no database, no environment, no I/O. It scans a text
// and reports hits by the SHAPE of substrings (secret token prefixes, digit
// groups passing a checksum), not by known values — the value-oriented
// masking of `myrmidon/secret-masking.ts` (S5) and `server/src/redaction.ts`
// stays untouched and continues to do the actual masking. 1.6.1 is
// flag-only: a hit produces an event, the text itself is never changed.
//
// Detectors:
//   secret: openai / anthropic keys, github ghp_/gho_ tokens, AWS AKIA ids,
//           slack xoxb- tokens, bearer JWTs, pcp_-prefixed tokens.
//   pii:    e-mail, phone numbers, payment cards (Luhn), SNILS, INN 10/12
//           (both pass a checksum). Legal-entity requisites (KPP, BIC and
//           friends) are a separate backlog item and stay out.
//
// All fixtures in tests are neutral (example.com, +1-555-01xx, reserved
// test card numbers); no real credential ever appears in this file.

export type GuardrailKind = "secret" | "pii";

export type GuardrailSecretSubtype =
  | "openai_key"
  | "anthropic_key"
  | "github_token"
  | "aws_access_key_id"
  | "slack_bot_token"
  | "bearer_jwt"
  | "pcp_token";

export type GuardrailPiiSubtype =
  | "email"
  | "phone"
  | "payment_card"
  | "snils"
  | "inn";

export type GuardrailSubtype = GuardrailSecretSubtype | GuardrailPiiSubtype;

export interface GuardrailHit {
  kind: GuardrailKind;
  subtype: GuardrailSubtype;
  /** 0..1 confidence of the shape match. */
  score: number;
  /** [start, end) character offsets into the scanned text. */
  span: [number, number];
}

export interface GuardrailReport {
  hits: GuardrailHit[];
  /** Aggregate counts per subtype, in hit order. */
  counts: Partial<Record<GuardrailSubtype, number>>;
  totalSecrets: number;
  totalPii: number;
  total: number;
}

/** Detector categories understood by MYRMIDON_GUARDRAILS_OUTPUT_CATEGORIES. */
export const GUARDRAIL_CATEGORIES = ["secret", "pii"] as const;
export type GuardrailCategory = (typeof GUARDRAIL_CATEGORIES)[number];

interface Detector {
  kind: GuardrailKind;
  subtype: GuardrailSubtype;
  score: number;
  re: RegExp;
  /** Extra shape validation beyond the regex (checksums). */
  validate?: (raw: string) => boolean;
}

// Bearer JWT: three base64url segments, the second is non-trivial.
const BASE64URL = "[A-Za-z0-9_-]";

const DETECTORS: Detector[] = [
  {
    kind: "secret",
    subtype: "openai_key",
    score: 0.95,
    re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "secret",
    subtype: "openai_key",
    score: 0.9,
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "secret",
    subtype: "anthropic_key",
    score: 0.95,
    re: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: "secret",
    subtype: "github_token",
    score: 0.95,
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: "secret",
    subtype: "aws_access_key_id",
    score: 0.9,
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: "secret",
    subtype: "slack_bot_token",
    score: 0.95,
    re: /\bxoxb-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: "secret",
    subtype: "bearer_jwt",
    score: 0.8,
    re: new RegExp(`\\beyJ${BASE64URL}+\\.${BASE64URL}{8,}\\.${BASE64URL}+\\b`, "g"),
  },
  {
    kind: "secret",
    subtype: "pcp_token",
    score: 0.9,
    re: /\bpcp_[A-Za-z0-9]{16,}\b/g,
  },
  {
    kind: "pii",
    subtype: "email",
    score: 0.7,
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "pii",
    subtype: "phone",
    score: 0.5,
    // E.164-ish: an optional +, then 7..15 digits with . - ( ) or spaces
    // between digit groups. Neutral fixtures use +1-555-01xx.
    re: /(?<![\w/])\+?[0-9][0-9()\-. ]{6,19}[0-9](?![\w])/g,
    validate: (raw) => {
      const digits = raw.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 15;
    },
  },
  {
    kind: "pii",
    subtype: "payment_card",
    score: 0.85,
    re: /(?<![\d-])\d{13,19}(?![\d])/g,
    validate: luhn,
  },
  {
    kind: "pii",
    subtype: "snils",
    score: 0.75,
    // SNILS: 11 digits, printed 000-000-000 00 or bare.
    re: /(?<![\d-])(?:\d{3}-\d{3}-\d{3}[ ]?\d{2}|\d{11})(?![\d])/g,
    validate: snilsChecksum,
  },
  {
    kind: "pii",
    subtype: "inn",
    score: 0.7,
    // INN 10/12 digits; must pass its checksum to count.
    re: /(?<![\d-])\d{10}(?![\d])|(?<![\d-])\d{12}(?![\d])/g,
    validate: innChecksum,
  },
];

function luhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function snilsChecksum(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  const body = digits.slice(0, 9);
  let weighted = 0;
  for (let i = 0; i < 9; i += 1) {
    weighted += (body.charCodeAt(i) - 48) * (9 - i);
  }
  const control = weighted % 101 % 10;
  const given = digits.slice(9);
  return Number(given) === control;
}

function innChecksum(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  const d = digits.split("").map((c) => c.charCodeAt(0) - 48);
  if (digits.length === 10) {
    const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    const control = weights.reduce((acc, w, i) => acc + w * d[i], 0) % 11 % 10;
    return control === d[9];
  }
  if (digits.length === 12) {
    const w11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const w12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const c11 = w11.reduce((acc, w, i) => acc + w * d[i], 0) % 11 % 10;
    if (c11 !== d[10]) return false;
    const c12 = w12.reduce((acc, w, i) => acc + w * d[i], 0) % 11 % 10;
    return c12 === d[11];
  }
  return false;
}

/**
 * Scan one text for secret/pii shapes.
 *
 * Overlaps are resolved by priority: secret wins over pii, a higher score
 * wins inside a kind, and a longer span wins between equal scores. This
 * keeps a `Bearer <jwt>` from also counting as three phone-shaped numbers.
 */
export function detectGuardrailHits(text: string, categories: readonly GuardrailCategory[] = GUARDRAIL_CATEGORIES): GuardrailHit[] {
  if (typeof text !== "string" || text.length === 0) return emptyReport([], categories).hits;
  const wanted = new Set(categories);
  const candidates: GuardrailHit[] = [];
  for (const detector of DETECTORS) {
    if (!wanted.has(detector.kind)) continue;
    const re = new RegExp(detector.re.source, detector.re.flags);
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      if (raw.length === 0) continue;
      if (detector.validate && !detector.validate(raw)) continue;
      candidates.push({
        kind: detector.kind,
        subtype: detector.subtype,
        score: detector.score,
        span: [match.index, match.index + raw.length],
      });
    }
  }
  return candidates.sort(overlapOrder).filter(keepNonOverlapping);
}

function overlapOrder(a: GuardrailHit, b: GuardrailHit): number {
  if (a.kind !== b.kind) return a.kind === "secret" ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  const lenA = a.span[1] - a.span[0];
  const lenB = b.span[1] - b.span[0];
  if (lenB !== lenA) return lenB - lenA;
  return a.span[0] - b.span[0];
}

function overlaps(a: GuardrailHit, b: GuardrailHit): boolean {
  return a.span[0] < b.span[1] && b.span[0] < a.span[1];
}

function keepNonOverlapping(hit: GuardrailHit, index: number, sorted: GuardrailHit[]): boolean {
  // `index` is this hit's own position in the sorted array; every earlier
  // entry has already been accepted, so a hit never compares with itself.
  return !sorted.slice(0, index).some((earlier) => overlaps(earlier, hit));
}

/** Build the aggregate report for a set of hits. */
export function summarizeGuardrailHits(hits: GuardrailHit[]): GuardrailReport {
  const counts: Partial<Record<GuardrailSubtype, number>> = {};
  let totalSecrets = 0;
  let totalPii = 0;
  for (const hit of hits) {
    counts[hit.subtype] = (counts[hit.subtype] ?? 0) + 1;
    if (hit.kind === "secret") totalSecrets += 1;
    else totalPii += 1;
  }
  return { hits, counts, totalSecrets, totalPii, total: hits.length };
}

function emptyReport(hits: GuardrailHit[], _categories: readonly GuardrailCategory[]): GuardrailReport {
  return { hits, counts: {}, totalSecrets: 0, totalPii: 0, total: 0 };
}

/** Scan and summarize in one call — the shape the run-output hook uses. */
export function scanGuardrailText(text: string, categories: readonly GuardrailCategory[] = GUARDRAIL_CATEGORIES): GuardrailReport {
  if (typeof text !== "string" || text.length === 0) {
    return summarizeGuardrailHits([]);
  }
  return summarizeGuardrailHits(detectGuardrailHits(text, categories));
}

/**
 * A short, already-masked excerpt around a hit: the caller passes the text
 * AFTER it went through the existing masking, the excerpt is cut around the
 * same span so the journal never stores raw secrets. Returns null when the
 * span falls outside the masked text.
 */
export function guardrailSnippet(maskedText: string, span: [number, number], maxChars = 96): string | null {
  if (typeof maskedText !== "string" || maskedText.length === 0) return null;
  const start = Math.max(0, Math.min(span[0], maskedText.length));
  const end = Math.max(start, Math.min(span[1], maskedText.length));
  const pad = Math.max(0, Math.floor((maxChars - (end - start)) / 2));
  const from = Math.max(0, start - pad);
  const to = Math.min(maskedText.length, Math.max(end, end + pad));
  const snippet = maskedText.slice(from, to);
  if (snippet.trim().length === 0) return null;
  return snippet.length > maxChars ? `${snippet.slice(0, maxChars - 1)}…` : snippet;
}
