// myrmidon(1.6-GRD): self-checks for the GUARDRAILS reference corpus.
//
// The corpus is data; these tests prove the data is trustworthy:
//  - schema is valid (loader validation passes);
//  - category counts meet the thresholds from the issue;
//  - every number that claims a valid checksum really is valid
//    (Luhn for cards, official algorithms for INN and SNILS);
//  - texts contain only neutral data — no internal host/agent markers;
//  - the loader rejects malformed input (duplicate ids, unknown categories,
//    empty text, expect/category mismatch).
import { describe, expect, it } from "vitest";

import {
  CORPUS_CATEGORIES,
  CorpusValidationError,
  loadCorpus,
  resetCorpusCache,
  validateCorpusCases,
  type CorpusCase,
} from "./index.js";

const CASES: CorpusCase[] = loadCorpus();

const MIN_CASES = 60;
const MIN_PER_CATEGORY: Record<string, number> = {
  secret: 15,
  pii: 15,
  injection: 15,
  benign: 20,
};

// --- checksum helpers (independent implementations, not from the corpus) ---

function luhnValid(card: string): boolean {
  const digits = [...card].filter((c) => c >= "0" && c <= "9");
  if (digits.length < 2) {
    return false;
  }
  let total = 0;
  for (let i = digits.length - 1, pos = 0; i >= 0; i -= 1, pos += 1) {
    let d = Number(digits[i]);
    if (pos % 2 === 1) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    total += d;
  }
  return total % 10 === 0;
}

const INN10_W = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN11_W = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_W = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function innValid(value: string): boolean {
  const d = [...value].map(Number);
  if (value.length === 10) {
    const n10 = INN10_W.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11 % 10;
    return n10 === d[9];
  }
  if (value.length === 12) {
    const n11 = INN11_W.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11 % 10;
    const n12 = INN12_W.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11 % 10;
    return n11 === d[10] && n12 === d[11];
  }
  return false;
}

function snilsValid(value: string): boolean {
  const d = [...value.replace(/\D/g, "")].map(Number);
  if (d.length !== 11) {
    return false;
  }
  let s = 0;
  for (let i = 0; i < 9; i += 1) {
    s += (9 - i) * d[i]!;
  }
  if (s === 100 || s === 101) {
    s = 0;
  }
  return d[9]! * 10 + d[10]! === s;
}

// --- neutral-data guard: internal markers must not appear ---

const FORBIDDEN_MARKERS = [
  "myrmidon",
  "paperclip",
  "vm-exec",
  "adm-dev",
  "itkadr",
  "bastionprime",
  "OPE-",
  "agent-b", // corpus convention allows only agent-a as the neutral agent name
];

function assertNeutral(c: CorpusCase): void {
  for (const marker of FORBIDDEN_MARKERS) {
    expect(c.text.toLowerCase()).not.toContain(marker.toLowerCase());
  }
}

describe("GUARDRAILS corpus schema", () => {
  it("loads and validates every case", () => {
    expect(CASES.length).toBeGreaterThan(0);
    for (const c of CASES) {
      expect(CORPUS_CATEGORIES).toContain(c.category);
      expect(c.id).toBeTruthy();
      expect(c.text.trim()).not.toBe("");
    }
  });

  it("has unique ids", () => {
    const ids = new Set(CASES.map((c) => c.id));
    expect(ids.size).toBe(CASES.length);
  });

  it("meets the per-category thresholds", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(MIN_CASES);
    for (const [category, min] of Object.entries(MIN_PER_CATEGORY)) {
      const count = CASES.filter((c) => c.category === category).length;
      expect(count, `category ${category}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("contains both Russian and English injection cases", () => {
    const injections = CASES.filter((c) => c.category === "injection");
    const hasCyrillic = injections.some((c) => /[а-яё]/i.test(c.text));
    const hasLatin = injections.some((c) => !/[а-яё]/i.test(c.text));
    expect(hasCyrillic).toBe(true);
    expect(hasLatin).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(() =>
      validateCorpusCases(
        [{ ...CASES[0]!, id: CASES[1]!.id }, CASES[1]!],
        "test.json",
      ),
    ).toThrow(CorpusValidationError);
    expect(() =>
      validateCorpusCases(
        [{ ...CASES[0]!, category: "no-such-category" }],
        "test.json",
      ),
    ).toThrow(CorpusValidationError);
    expect(() =>
      validateCorpusCases([{ ...CASES[0]!, text: "   " }], "test.json"),
    ).toThrow(CorpusValidationError);
    expect(() =>
      validateCorpusCases([{ ...CASES[0]!, expect: { detector: "nope" } }], "test.json"),
    ).toThrow(CorpusValidationError);
    // benign case must not expect a detector
    const benignCase = CASES.find((c) => c.category === "benign")!;
    expect(() =>
      validateCorpusCases(
        [{ ...benignCase, expect: { detector: "secret" } }],
        "test.json",
      ),
    ).toThrow(CorpusValidationError);
    // loader memoization round-trip still validates
    resetCorpusCache();
    expect(loadCorpus().length).toBe(CASES.length);
  });
});

describe("GUARDRAILS corpus checksums", () => {
  const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

  it("every card-like number passes Luhn", () => {
    const cardCases = CASES.filter(
      (c) => c.subtype.startsWith("card-number"),
    );
    expect(cardCases.length).toBeGreaterThanOrEqual(4);
    for (const c of cardCases) {
      const numbers = c.text.match(CARD_RE) ?? [];
      const checked = numbers.filter((n) => n.replace(/\D/g, "").length >= 13);
      expect(checked.length).toBeGreaterThan(0);
      for (const n of checked) {
        expect(luhnValid(n), `Luhn must pass for ${n} in ${c.id}`).toBe(true);
      }
    }
  });

  it("every INN passes the official checksum", () => {
    const innCases = CASES.filter((c) => c.subtype.startsWith("inn-ru"));
    expect(innCases.length).toBeGreaterThanOrEqual(3);
    for (const c of innCases) {
      const inns = c.text.match(/\b\d{10}\b|\b\d{12}\b/g) ?? [];
      expect(inns.length).toBeGreaterThan(0);
      for (const v of inns) {
        expect(innValid(v), `INN checksum must pass for ${v} in ${c.id}`).toBe(
          true,
        );
      }
    }
  });

  it("every SNILS passes the official checksum", () => {
    const snilsCases = CASES.filter((c) => c.subtype.startsWith("snils-ru"));
    expect(snilsCases.length).toBeGreaterThanOrEqual(2);
    for (const c of snilsCases) {
      const digits = c.text.replace(/\D/g, "");
      const candidates = [
        ...(c.text.match(/\b\d{3}-\d{3}-\d{3}\s\d{2}\b/g) ?? []),
        ...(c.text.match(/\b\d{11}\b/g) ?? []),
      ];
      expect(candidates.length).toBeGreaterThan(0);
      for (const v of candidates) {
        expect(
          snilsValid(v),
          `SNILS checksum must pass for ${v} in ${c.id}`,
        ).toBe(true);
      }
      // sanity: the normalized 11 digits must also validate
      if (digits.length === 11) {
        expect(snilsValid(digits), `SNILS digits must pass for ${c.id}`).toBe(
          true,
        );
      }
    }
  });
});

describe("GUARDRAILS corpus neutrality", () => {
  it("uses only neutral emails, phones and hosts", () => {
    for (const c of CASES) {
      // emails must be example.com or subdomains (dotted domain required, so
      // userinfo pairs like root:P@ssw0rd123 are not mistaken for addresses)
      const emails = c.text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
      for (const e of emails) {
        expect(e.endsWith("@example.com"), `neutral email ${e} in ${c.id}`).toBe(
          true,
        );
      }
      // phones must stay in the +1-555-01xx documentation range
      const phones = c.text.match(/\+1-\d{3}-\d{4}/g) ?? [];
      for (const p of phones) {
        expect(p.startsWith("+1-555-01"), `neutral phone ${p} in ${c.id}`).toBe(
          true,
        );
      }
      // IPs must stay in the documentation range 192.0.2.0/24
      const ips = c.text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? [];
      for (const ip of ips) {
        expect(ip.startsWith("192.0.2."), `neutral ip ${ip} in ${c.id}`).toBe(
          true,
        );
      }
    }
  });

  it("contains no internal host or agent markers", () => {
    for (const c of CASES) {
      assertNeutral(c);
    }
  });

  it("benign texts contain no real credential values", () => {
    for (const c of CASES.filter((x) => x.category === "benign")) {
      expect(c.text).not.toMatch(
        /\b(AKIA|ghp_|gho_|github_pat_|xox[bap]-|sk-|sk_|AIza|SG\.)\w/,
      );
    }
  });
});
