// myrmidon(1.6-GRD): prompt-injection flagging on untrusted run input (1.6.1, part B).
//
// Flag-only mode: nothing is blocked, no text is masked or removed. When the
// feature is enabled, the wake queue wraps the text of externally authored
// comments in <untrusted-data> markers before it lands in the wake payload the
// run reads, so the model sees "data, not instructions"; a heuristic detector
// scores the same text and the flag travels next to the markers. The run
// starts exactly as before (owner decision 03.10: blocking modes are 1.5).
//
// The journal of flagged events is owned by sibling part A
// (server/src/myrmidon/guardrails/events.ts, recordGuardrailEvent). This part
// does not create that module or its table; it publishes the flag through the
// payload and matches the fixed contract once A merges.
//
// Regex note: JavaScript `\b` is ASCII-only, so no `\b` is used around
// Cyrillic words (it would never match there); Cyrillic word boundaries use
// explicit lookarounds only where a stem could otherwise hide inside a
// longer unrelated word.

export const UNTRUSTED_DATA_OPEN = "<untrusted-data>";
export const UNTRUSTED_DATA_CLOSE = "</untrusted-data>";

export const GUARDRAILS_INJECTION_ENABLED_ENV = "MYRMIDON_GUARDRAILS_INJECTION_ENABLED";
export const GUARDRAILS_INJECTION_SCORE_ENV = "MYRMIDON_GUARDRAILS_INJECTION_SCORE";

/** Default score threshold; 0.0 flags everything, 1.0 flags nothing. */
export const DEFAULT_INJECTION_SCORE_THRESHOLD = 0.6;

export type InjectionScanResult = {
  flagged: boolean;
  /** Heuristic score in 0..1; never below 0, never above 1. */
  score: number;
  /** Ids of the heuristic groups that matched, deduplicated. */
  matched: string[];
};

export type UntrustedWrapResult = {
  /** The wrapped text, ready for the run payload. */
  text: string;
  scan: InjectionScanResult;
};

/**
 * Whether the injection flagging layer is on. Off unless the operator turns
 * it on: unset or blank stays off, and only `1`/`true`/`yes`/`on` turn it on.
 * Any other value (a typo) stays off, so an error cannot silently enable it.
 */
export function guardrailsInjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GUARDRAILS_INJECTION_ENABLED_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Score threshold from `MYRMIDON_GUARDRAILS_INJECTION_SCORE`. Unset, blank,
 * non-numeric or out-of-range values fall back to the default 0.6.
 */
export function injectionScoreThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GUARDRAILS_INJECTION_SCORE_ENV]?.trim();
  if (!raw) return DEFAULT_INJECTION_SCORE_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return DEFAULT_INJECTION_SCORE_THRESHOLD;
  }
  return value;
}

type HeuristicGroup = {
  id: string;
  /** Patterns applied to the lower-cased text. */
  patterns: RegExp[];
  /** Weight added to the score when at least one pattern matches. */
  weight: number;
};

/**
 * Heuristic groups, RU + EN. Each group adds its weight once, however many
 * of its patterns match, so one burst of synonyms cannot saturate the score.
 *
 * Weights: every strong group (instruction override, role hijack, authority
 * claim, credential probe, hidden instruction) sits at the default threshold
 * (0.6), because each of those alone is a real attempt; only the urgency
 * group is deliberately sub-threshold (0.3) — "execute immediately" by itself
 * is also how a legitimate operator talks, so it flags only when it combines
 * with a second group.
 */
const HEURISTIC_GROUPS: readonly HeuristicGroup[] = [
  {
    // Imperatives that try to override the agent's instructions.
    id: "override_imperative",
    weight: 0.6,
    patterns: [
      /\bignore (?:all )?(?:previous|prior|above|earlier|preceding)\b/,
      /\bdisregard (?:all )?(?:previous|prior|above|earlier|preceding)\b/,
      /\bforget (?:all|your|the|these)\b.{0,24}\b(?:instructions?|rules?|directions?|guidance)\b/,
      /забудь (?:все|про|свои|эти).{0,24}(?:инструкции|указания|правила|наставления)/,
      /игнорируй (?:все|предыдущие|прошлые|выше|свои)/,
      /пропусти (?:все )?(?:предыдущие|прошлые).{0,24}(?:инструкции|указания)/,
    ],
  },
  {
    // Attempts to re-role the agent or replace its instructions wholesale.
    id: "role_hijack",
    weight: 0.6,
    patterns: [
      /\byou are now\b/,
      /новая (?:роль|инструкция)/,
      /отныне ты.{0,40}(?:нов|друг|иная)/,
      /\bfrom now on\b.{0,40}\byou (?:are|must|will)\b/,
      /\bact as (?:a|an|if)\b/,
      /действуй как/,
      /\bnew (?:system|developer) (?:instructions?|rules?|message)\b/,
      /теперь твоя задача/,
    ],
  },
  {
    // Claims about the agent's authority, used to unlock restricted actions.
    // An interrogative ("do you have access to?") is a question, not a claim,
    // so the plain English pattern excludes it with a lookbehind.
    id: "authority_claim",
    weight: 0.6,
    patterns: [
      /(?<!\bdo )\byou have access to\b/,
      /у тебя есть доступ к/,
      /\byou (?:are|were) (?:given|granted|allowed)\b.{0,32}\b(?:access|permission|key|secret|password)\b/,
      /тебе (?:разрешено|выдан|дан|предоставлен).{0,32}(?:доступ|прав|ключ|секрет|пароль)/,
      /\bthe (?:owner|admin|administrator|system) (?:says|said|told you|asked you|approves?)\b.{0,40}\b(?:to|that)\b/,
      /владелец (?:сказал|разрешил|одобрил)/,
      /\bthis is (?:an? )?(?:official|authorized|approved)\b.{0,32}\b(?:instruction|command|request)\b/,
      /я (?:владелец|администратор|создатель)/,
    ],
  },
  {
    // Requests to reveal keys, secrets, passwords or other credentials.
    id: "credential_probe",
    weight: 0.6,
    patterns: [
      /\b(?:reveal|show|print|share|send|tell me)\b.{0,24}\b(?:api|secret|token|password|credentials?|keys?)\b/,
      /(?:раскрой|покажи|выведи|напиши|пришли|скажи мне|отправь).{0,32}(?<![а-яё])(?:api|секрет|токен|парол|ключ)(?![а-яё])/,
      /\bwhat(?:'s| is) the (?:api key|secret|token|password|credential)\b/,
      /вставь сюда.{0,24}(?<![а-яё])(?:ключ|секрет|пароль|токен)(?![а-яё])/,
      /\bpaste (?:the|your) (?:api key|secret|token|password|credential)\b/,
      /\benv\b.{0,12}\b(?:vars?|переменные)\b.{0,24}\b(?:весь|all|полностью)\b/,
    ],
  },
  {
    // Instruction-shaped text that hides inside quoted "data" blocks.
    id: "hidden_instruction",
    weight: 0.6,
    patterns: [
      /<\|?(?:im_start|system|assistant|user)\|?>|<\/?system_prompt>/,
      /\[system\]|\[instructions?\]/,
      /\b(?:the|this) (?:text|data|content|document|file|message) (?:above|below|inside)\b.{0,48}\b(?:instruct|contains? (?:secret|hidden)|is actually)\b/,
      /(?:в|этот|нижеследующ) (?:текст|документ|файл|сообщени)\w*\b.{0,48}\b(?:скрыт\w*|на самом деле)\b.*(?:инструкц|указани|команд)/,
      /\bhidden (?:instruction|message|directive)\b/,
      /скрытая инструкция/,
      /\bdo not tell the (?:user|owner|system|anyone)\b/,
    ],
  },
  {
    // Urgency pressure: execute right now, no verification, no reporting.
    // Sub-threshold by design: alone it is also ordinary operator speech;
    // it pushes the score over the line only together with another group.
    id: "urgency_pressure",
    weight: 0.3,
    patterns: [
      /\b(?:execute|run|do) (?:this|it) (?:now|immediately|right away|asap|without)\b/,
      /выполни (?:это )?(?:немедленно|сейчас же|прямо сейчас|без)/,
      /\bexecute immediately\b/,
      /не (?:(?:за|пере)прашивай|проверяй|откладывай)/,
      /\bwithout (?:asking|confirming|verifying|delay)\b/,
      /\bkeep (?:this|it) secret\b|это (?:секрет|конфиденциально)/,
    ],
  },
  {
    // Direct second-person commands toward the agent itself. Requires the
    // imperative verb to be followed by a pronoun/addressed instruction, so
    // neutral third-person talk ("the run must", "the agent should") and
    // ordinary past-tense reports stay out. Sub-threshold alone (0.3): it
    // is the amplifier that pushes an urgency or secrecy pattern over.
    id: "imperative_address",
    weight: 0.3,
    patterns: [
      /\b(?:execute|run|do|send|forward|publish|delete|copy|repeat) (?:this|it|that|the)\b.{0,32}\b(?:now|immediately|for me|to me|my)\b/,
      /\bсделай (?:это|так|вот так)\b/,
      /\bотправь (?:все|всё|это|файл)\b/,
      /\bвыполни (?:мо[её]|i)\b.{0,24}\b(?:указание|просьбу|требование)\b/,
      /\bfor me\b.{0,16}\b(?:now|immediately|right away)\b/,
    ],
  },
] as const;

/**
 * Scans untrusted text for prompt-injection heuristics. Pure: no env, no IO,
 * no state. The threshold is passed in so callers (and tests) control it;
 * use `injectionScoreThreshold()` for the env-configured value.
 */
export function scanForInjection(
  text: string,
  threshold: number = DEFAULT_INJECTION_SCORE_THRESHOLD,
): InjectionScanResult {
  const haystack = text.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const group of HEURISTIC_GROUPS) {
    if (group.patterns.some((pattern) => pattern.test(haystack))) {
      matched.push(group.id);
      score += group.weight;
    }
  }
  const bounded = Math.max(0, Math.min(1, score));
  return { flagged: bounded >= threshold, score: bounded, matched };
}

/**
 * Wraps untrusted text in the data-not-instructions envelope and scans it.
 * The caller stores the returned `text` in the run payload only; the UI view
 * of the comment is untouched. Already wrapped text is returned as is, so a
 * re-queue of the same comment cannot nest the markers.
 */
export function wrapUntrusted(
  text: string,
  threshold: number = DEFAULT_INJECTION_SCORE_THRESHOLD,
): UntrustedWrapResult {
  const trimmed = text.trim();
  if (
    trimmed.startsWith(UNTRUSTED_DATA_OPEN) &&
    trimmed.endsWith(UNTRUSTED_DATA_CLOSE)
  ) {
    return { text, scan: scanForInjection(text, threshold) };
  }
  const wrapped = `${UNTRUSTED_DATA_OPEN}${text}${UNTRUSTED_DATA_CLOSE}`;
  return { text: wrapped, scan: scanForInjection(text, threshold) };
}
