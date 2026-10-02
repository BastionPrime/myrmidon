// server/src/myrmidon/client-mail/dossier.ts
//
// myrmidon(EXTCASE-M): the tender fields of a recognized document, as JSON.
//
// A tender pack is hundreds of pages of prose. The bot on the platform needs
// four things from it — the procurement number, the deadlines, the sums and the
// requirements — and the board task carries those fields, not the document.
// This module is the pure function that produces them from recognized text.
//
// Deliberately pure: no model call, no locale-dependent parsing, same input →
// same output. The text itself goes to the workspace and to the task
// description; this excerpt is the part a person reads first, so it must not
// vary between runs or be invented by a model. The mail path only asks a model
// about *sorting*, never about the content of a client's document.
//
// Nothing here decides whether a document is a tender: the pipeline does that on
// the mail (subject, sender, and whether a recognized document carries a
// procurement number or a deadline), so this file stays one job.

import type { TenderDossier } from "@paperclipai/shared";

/** Caps of one dossier; the task description is read by a person, not a machine. */
export interface TenderDossierLimits {
  maxDeadlines: number;
  maxSums: number;
  maxRequirements: number;
}

export const DEFAULT_TENDER_DOSSIER_LIMITS: TenderDossierLimits = {
  maxDeadlines: 20,
  maxSums: 20,
  maxRequirements: 20,
};

/** A stored line is trimmed to this many characters. */
const MAX_LINE_CHARS = 400;

const MONTHS: Record<string, string> = {
  января: "01", февраля: "02", марта: "03", апреля: "04", мая: "05", июня: "06",
  июля: "07", августа: "08", сентября: "09", октября: "10", ноября: "11", декабря: "12",
};

/** Date forms a Russian tender uses: `31.12.2026`, `31/12/2026`, `2026-12-31`, `31 декабря 2026`. */
const DATE_PATTERNS: Array<{ re: RegExp; toIso: (m: RegExpMatchArray) => string | null }> = [
  {
    re: /\b(\d{2})[.\-/](\d{2})[.\-/](\d{4})\b/,
    toIso: (m) => (m[1] && m[2] && m[3] ? `${m[3]}-${m[2]}-${m[1]}` : null),
  },
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
    toIso: (m) => (m[1] && m[2] && m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null),
  },
  {
    re: /\b(\d{1,2})\s+([а-яё]+)\s+(\d{4})\b/i,
    toIso: (m) => {
      const month = MONTHS[(m[2] ?? "").toLowerCase()];
      if (!month || !m[3] || !m[1]) return null;
      return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
    },
  },
];

/** Words that make a line a deadline even without a full date. */
const DEADLINE_WORDS = [
  "срок", "не позднее", "окончание", "окончан", "подведен", "вскрыт",
  "приём заявок", "прием заявок", "подача заявок", "заявки принимаются",
];

/** Words that start a requirement. */
const REQUIREMENT_WORDS = [
  "должен", "должна", "должно", "должны", "обязан", "обязательно", "требуется",
  "не допускается", "не допускают", "запрещено", "запрещается", "необходимо",
];

/** Words that name a procurement number, in the order they are tried. */
const NUMBER_LABELS = [
  /(?:номер|№)\s*(?:закупки|извещения|запроса|лота)?\s*[:№]?\s*([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9\-/_.]{3,60})/i,
  /(?:закупка|извещение|запрос\s+котировок|аукцион)\s*(?:№|номер)?\s*[:№]?\s*([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9\-/_.]{3,60})/i,
];

/** A money amount: digits with space/thin-space groups, an optional decimal part. */
const AMOUNT_RE = /(\d[\d\u00a0\u202f ]{0,18}(?:[.,]\d{1,2})?)\s*(₽|руб\.?|рублей|р\.|RUB|USD|EUR|доллар\w*|евро)?/gi;

/** Bytes of the recognized text are looked at as one string; the caps bound the scan. */
const MAX_SCAN_CHARS = 1_000_000;

/** Words that make a document a tender at all. */
const TENDER_WORDS = [
  "закупк", "тендер", "аукцион", "котировочн", "извещение", "контракт",
  "техническое задание", "лот ", "нмцк",
];

export function cleanDossierLine(line: string): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LINE_CHARS ? `${collapsed.slice(0, MAX_LINE_CHARS - 1)}…` : collapsed;
}

export function extractDateIso(line: string): string | null {
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.re.exec(line);
    if (!match) continue;
    const iso = pattern.toIso(match);
    if (iso) return iso;
  }
  return null;
}

/** Whether recognized text carries a tender at all. Reason only, never a body. */
export function looksLikeTender(text: string): boolean {
  const lower = text.slice(0, MAX_SCAN_CHARS).toLowerCase();
  return TENDER_WORDS.some((word) => lower.includes(word));
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[\u00a0\u202f ]/g, "").replace(",", ".");
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizeCurrency(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\.$/, "");
  const lower = trimmed.toLowerCase();
  if (lower === "₽" || lower.startsWith("руб") || lower === "р") return "RUB";
  if (lower === "usd" || lower.startsWith("доллар")) return "USD";
  if (lower === "eur" || lower.startsWith("евро")) return "EUR";
  return trimmed.slice(0, 8);
}

/** The procurement number of a document, or null when no label matched. */
export function extractTenderNumber(text: string): string | null {
  for (const pattern of NUMBER_LABELS) {
    const match = pattern.exec(text);
    const candidate = match?.[1]?.trim();
    // A label like "закупка" followed by the word "товаров" is prose, not a number.
    if (candidate && /\d/.test(candidate)) return candidate.slice(0, 255);
  }
  return null;
}

export interface TenderDossierInput {
  /** Recognized text of one document; several documents are merged by the caller. */
  text: string;
  /** Message the text came from. */
  messageId: string;
  /** Attachment name the text was recognized from. */
  attachmentName: string;
}

/**
 * The fields of one recognized document. `{}`-shaped accumulators are returned
 * rather than merged, so the caller can merge several attachments of one
 * message into one dossier with `mergeTenderParts`.
 */
export interface TenderPart {
  number: string | null;
  deadlines: Array<{ text: string; date: string | null }>;
  sums: Array<{ text: string; amount: number; currency: string | null }>;
  requirements: string[];
}

export function extractTenderPart(
  input: TenderDossierInput,
  limits: TenderDossierLimits = DEFAULT_TENDER_DOSSIER_LIMITS,
): TenderPart {
  const text = input.text.slice(0, MAX_SCAN_CHARS);
  const part: TenderPart = {
    number: extractTenderNumber(text),
    deadlines: [],
    sums: [],
    requirements: [],
  };

  const seenDeadlines = new Set<string>();
  const seenSums = new Set<string>();
  const seenRequirements = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanDossierLine(rawLine);
    if (!line) continue;
    const lower = line.toLowerCase();

    if (part.deadlines.length < limits.maxDeadlines) {
      const hasDeadlineWord = DEADLINE_WORDS.some((word) => lower.includes(word));
      const iso = extractDateIso(line);
      // A date alone is not a deadline: "31.12.2026" appears in contracts too.
      // A deadline needs the word, or the word *and* a date; a line with only a
      // date is kept when the document already looks like a tender, because a
      // tender's date lines are its key dates.
      if (hasDeadlineWord && !seenDeadlines.has(line)) {
        seenDeadlines.add(line);
        part.deadlines.push({ text: line, date: iso });
      }
    }

    if (part.sums.length < limits.maxSums && /(стоимост|цена|сумм|нмцк|бюджет|итого|руб|₽)/i.test(lower)) {
      const match = AMOUNT_RE.exec(line);
      AMOUNT_RE.lastIndex = 0;
      const amount = match ? parseAmount(match[1] ?? "") : null;
      // Below a thousand the match is usually a quantity or an article number.
      if (amount !== null && amount >= 1000 && !seenSums.has(line)) {
        seenSums.add(line);
        part.sums.push({ text: line, amount, currency: normalizeCurrency(match?.[2]) });
      }
    }

    if (part.requirements.length < limits.maxRequirements) {
      if (REQUIREMENT_WORDS.some((word) => lower.includes(word)) && !seenRequirements.has(line)) {
        seenRequirements.add(line);
        part.requirements.push(line);
      }
    }
  }

  return part;
}

/** Merges the parts of one message's attachments, keeping the first number seen. */
export function mergeTenderParts(parts: TenderPart[]): TenderPart {
  const merged: TenderPart = { number: null, deadlines: [], sums: [], requirements: [] };
  for (const part of parts) {
    if (!merged.number && part.number) merged.number = part.number;
    merged.deadlines.push(...part.deadlines);
    merged.sums.push(...part.sums);
    merged.requirements.push(...part.requirements);
  }
  return merged;
}

/** The dossier of one message, built from the merged parts of its attachments. */
export function buildTenderDossier(input: {
  parts: TenderPart[];
  messageId: string;
  attachmentNames: string[];
}): TenderDossier {
  const merged = mergeTenderParts(input.parts);
  return {
    number: merged.number,
    deadlines: merged.deadlines,
    sums: merged.sums,
    requirements: merged.requirements,
    messageId: input.messageId,
    attachments: input.attachmentNames,
  };
}

/**
 * Whether a dossier carries enough to be worth a board task. A document with no
 * number, no deadline and no sum is prose: the bot on the platform could do
 * nothing with it, and a task per such document would be noise.
 */
export function dossierIsActionable(dossier: TenderDossier): boolean {
  return Boolean(dossier.number) || dossier.deadlines.length > 0 || dossier.sums.length > 0;
}