// server/src/myrmidon/ocr/structure.ts
//
// myrmidon(EXT-CASE-OCR): the structural excerpt of a tender document.
//
// A tender pack is hundreds of pages; the bot needs the three things a bid is
// actually built from — requirements, deadlines and positions — without pasting
// the whole document into the model context. The full text still goes to the
// workspace; this excerpt is the small, deterministic part of the result.
//
// The extraction is deliberately a pure function over the recognized text: no
// model call, no locale-dependent parsing, same input → same output. A model
// would cope with odd layouts better, but it would also make the result
// untestable and silently different between runs, while the excerpt is only a
// convenience on top of the text the bot can always read in full.

import type { TenderDeadline, TenderPosition, TenderRequirement, TenderStructure } from "./types.js";

export interface TenderStructureLimits {
  maxRequirements: number;
  maxDeadlines: number;
  maxPositions: number;
}

export const DEFAULT_STRUCTURE_LIMITS: TenderStructureLimits = {
  maxRequirements: 50,
  maxDeadlines: 50,
  maxPositions: 100,
};

/** A stored line is trimmed to this many characters; the excerpt is a pointer, not the document. */
const MAX_LINE_CHARS = 400;
/** A heading is a short line; a longer one is content even when it starts with a capital. */
const MAX_HEADING_CHARS = 120;
const MAX_HEADING_WORDS = 8;

const MONTHS: Record<string, string> = {
  января: "01", февраля: "02", марта: "03", апреля: "04", мая: "05", июня: "06",
  июля: "07", августа: "08", сентября: "09", октября: "10", ноября: "11", декабря: "12",
};

/** Date forms a tender uses: `31.12.2026`, `31/12/2026`, `31-12-2026`, `2026-12-31`, `31 декабря 2026`. */
const DATE_PATTERNS: Array<{ re: RegExp; toIso: (m: RegExpMatchArray) => string | null }> = [
  {
    re: /\b(\d{2})[.\-/](\d{2})[.\-/](\d{4})\b/g,
    toIso: (m) => (m[3] && m[2] && m[1] ? `${m[3]}-${m[2]}-${m[1]}` : null),
  },
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    toIso: (m) => (m[1] && m[2] && m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null),
  },
  {
    re: /\b(\d{1,2})\s+([а-яё]+)\s+(\d{4})\b/gi,
    toIso: (m) => {
      const month = MONTHS[(m[2] ?? "").toLowerCase()];
      if (!month || !m[3] || !m[1]) return null;
      return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
    },
  },
];

/** Words that make a line a deadline even without a full date ("срок подачи — 10 дней"). */
const DEADLINE_WORDS = [
  "срок", "не позднее", "окончание", "окончан", "подведен", "вскрыт", "дата окончания",
  "приём заявок", "прием заявок", "подача заявок", "заявки принимаются",
];

/** Words that start a requirement. */
const REQUIREMENT_WORDS = [
  "должен", "должна", "должно", "должны", "обязан", "обязательно", "требуется",
  "не допускается", "не допускают", "запрещено", "запрещается", "необходимо",
];

/** Words that name a section of the pack. */
const SECTION_WORDS: Array<{ section: Section; re: RegExp }> = [
  { section: "requirements", re: /требован/ },
  { section: "deadlines", re: /срок|дата|подвед|окончан|вскрыт/ },
  { section: "positions", re: /позиц|номенклатур|перечень|спецификац|состав работ|лот|предмет закуп/ },
];

const BULLET_RE = /^\s*(?:[-–—•*]|\d{1,2}[.)])\s+(\S.*)$/;

const UNIT_RE = "(?:шт|ед|единиц|кг|т|тонн|м|м2|м3|пог\\.?\\s*м|л|упак|комплект|компл|пачк|рулон|мешок|секц)";
const POSITION_RE = new RegExp(`^(.{2,120}?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_RE})\\.?$`, "i");
const POSITION_ROW_RE = /^(.{2,120}?)\s*[|;]\s*(\d+(?:[.,]\d+)?)\s*[|;]\s*([^|;]{1,20})$/;

type Section = "requirements" | "deadlines" | "positions";
/** A section starts, a heading ends the current one (`null`), a content line (`undefined`). */
type HeadingResult = Section | null | undefined;

function cleanLine(line: string): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LINE_CHARS ? `${collapsed.slice(0, MAX_LINE_CHARS - 1)}…` : collapsed;
}

function extractDate(line: string): string | null {
  for (const pattern of DATE_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    const match = re.exec(line);
    if (!match) continue;
    const iso = pattern.toIso(match);
    if (iso) return iso;
  }
  return null;
}

function looksLikeDeadline(line: string): boolean {
  const lower = line.toLowerCase();
  return DEADLINE_WORDS.some((word) => lower.includes(word));
}

function looksLikeRequirement(line: string): boolean {
  const lower = line.toLowerCase();
  return REQUIREMENT_WORDS.some((word) => lower.includes(word));
}

/**
 * The section a heading opens, `null` for a heading that closes the previous
 * one, `undefined` for a content line.
 *
 * A line carrying a date or an obligation word is content, never a heading —
 * otherwise "Срок подачи заявок — до 31.12.2026" would open a section and be
 * dropped instead of recorded as a deadline.
 */
function headingSection(line: string, hasDate: boolean): HeadingResult {
  if (hasDate || looksLikeRequirement(line)) return undefined;
  if (line.length > MAX_HEADING_CHARS) return undefined;
  if (/[.!?]$/.test(line)) return undefined;
  if (line.split(/\s+/).length > MAX_HEADING_WORDS) return undefined;
  if (!/^(\d+(\.\d+)*[.)]?\s+)?["«]?[A-ZА-ЯЁ]/.test(line)) return undefined;
  // A line that carries a number outside its own numbering ("Кабель 5 м") is a
  // position or a table row, not a heading; a numbered heading ("3. Позиции")
  // loses its prefix before this check.
  if (/\d/.test(line.replace(/^\d+(\.\d+)*[.)]?\s+/, ""))) return undefined;
  const lower = line.toLowerCase();
  for (const entry of SECTION_WORDS) {
    if (entry.re.test(lower)) return entry.section;
  }
  return null;
}

function parsePosition(line: string): TenderPosition | null {
  const row = POSITION_ROW_RE.exec(line);
  if (row) {
    const [, name, quantity, unit] = row;
    if (name && quantity && unit) return { name: cleanLine(name), quantity, unit: cleanLine(unit) };
  }
  const simple = POSITION_RE.exec(line);
  if (simple) {
    const [, name, quantity, unit] = simple;
    if (name && quantity && unit && !looksLikeDeadline(line)) {
      return { name: cleanLine(name), quantity, unit: unit.toLowerCase() };
    }
  }
  return null;
}

/**
 * Requirements, deadlines and positions found in the recognized text.
 *
 * Lines are read once, in order. A heading opens a section. A line carrying a
 * date is a deadline; a line that starts with an obligation word, or one that
 * sits under a requirements heading, is a requirement (an obligation line that
 * mentions a term without a date is a requirement, not a deadline); a line with
 * a deadline word and no date is a deadline without a date. Duplicates keep
 * their first occurrence and every list is capped by `limits`.
 */
export function extractTenderStructure(
  text: string,
  limits: TenderStructureLimits = DEFAULT_STRUCTURE_LIMITS,
): TenderStructure {
  const requirements: TenderRequirement[] = [];
  const deadlines: TenderDeadline[] = [];
  const positions: TenderPosition[] = [];
  const seenRequirements = new Set<string>();
  const seenDeadlines = new Set<string>();

  let section: Section | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = cleanLine(raw);
    if (!line) continue;

    const date = extractDate(line);
    const heading = headingSection(line, date !== null);
    if (heading !== undefined) {
      section = heading;
      continue;
    }

    if (date !== null) {
      if (deadlines.length < limits.maxDeadlines && !seenDeadlines.has(line)) {
        seenDeadlines.add(line);
        deadlines.push({ text: line, date });
      }
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const body = bullet?.[1] ? cleanLine(bullet[1]) : line;
    if (looksLikeRequirement(line) || section === "requirements") {
      if (requirements.length < limits.maxRequirements && !seenRequirements.has(body)) {
        seenRequirements.add(body);
        requirements.push({ text: body });
      }
      continue;
    }

    if (looksLikeDeadline(line)) {
      if (deadlines.length < limits.maxDeadlines && !seenDeadlines.has(line)) {
        seenDeadlines.add(line);
        deadlines.push({ text: line, date: null });
      }
      continue;
    }

    const position = parsePosition(line);
    if (position && (section === "positions" || section === null)) {
      if (positions.length < limits.maxPositions) positions.push(position);
    }
  }

  return { requirements, deadlines, positions };
}