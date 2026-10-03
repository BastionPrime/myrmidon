/**
 * myrmidon(X9a): `@<alias>` addressing for the bridged Telegram chat.
 *
 * A message in a bridged conversation (DM or group topic) may start with — or
 * mention — `@<alias>`, and that addressee can be any agent of the same
 * company, not only the endpoint's assigned agent. This module resolves the
 * mention: it reads each agent's `telegramAliases` from the agent card JSON
 * (`agents.metadata` first, then `agents.adapter_config`; the vendor's card
 * is only read, never written), matches the mention against aliases, then
 * agent names, then titles, and returns the resolved agent plus the text with
 * the mention consumed (leading mentions only; mid-text mentions resolve but
 * keep the full text, the mention stays part of the sentence).
 *
 * An unknown alias resolves to null together with the list of valid
 * addressees, so the caller (part B) can answer politely with the candidates.
 * Resolution is read-only: one select over `agents`, no vendor file changes.
 */
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";

/** The addressee this module resolved, in the caller's terms. */
export interface TelegramAddressee {
  /** The matched agent's id (uuid, `agents.id`). */
  agentId: string;
  /** The agent's display name (`agents.name`). */
  displayName: string;
}

/**
 * What `resolveTelegramAddressee` hands back: either the matched addressee,
 * or null with the list of valid mentions for a polite hint (part B).
 */
export interface ResolveResult {
  /** The matched addressee, or null when the mention matched no agent. */
  addressee: TelegramAddressee | null;
  /**
   * Every mentionable handle of the company's agents, in stable order
   * (agent name first, then aliases, then title), lower-cased. Filled for
   * both matches and misses; an empty list means nobody is addressable.
   */
  candidates: string[];
  /**
   * The text with the addressee's leading mention removed. Non-null only
   * when the mention started the message; a mid-text mention keeps the
   * full text (it is part of the sentence, not a routing prefix).
   */
  consumedText: string | null;
}

/** A mention handle with the agent it belongs to. */
interface CandidateRow {
  agentId: string;
  displayName: string;
  /** Lower-cased handle for matching. */
  handle: string;
  /** "alias" beats "name" beats "title" when several agents match. */
  kind: "alias" | "name" | "title";
}

const KIND_ORDER: Record<CandidateRow["kind"], number> = {
  alias: 0,
  name: 1,
  title: 2,
};

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
// myrmidon(X9a): accepts the same db-or-transaction handles the bridge
// modules pass around, so a caller mid-transaction needs no cast.
type DbOrTx = Db | DbTransaction;

/**
 * Reads `telegramAliases` from one agent card JSON column value.
 * Absent, not an object, or a non-array field yield []; entries are
 * trimmed, lower-cased and de-duplicated; non-string entries drop.
 */
export function readTelegramAliases(cardJson: unknown): string[] {
  if (cardJson === null || typeof cardJson !== "object") return [];
  const raw = (cardJson as Record<string, unknown>).telegramAliases;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Finds the first `@<handle>` mention in a text: at the start (after
 * leading whitespace) or anywhere later. Returns the lower-cased handle
 * without the `@` and whether the mention led the message.
 */
export function findMention(text: string): {
  handle: string;
  leading: boolean;
} | null {
  if (typeof text !== "string" || !text.includes("@")) return null;
  const leading = /^\s*@([^\s@,.!?;:()[\]{}"'`]+)/.exec(text);
  if (leading) return { handle: leading[1]!.toLowerCase(), leading: true };
  const mid = /(^|\s)@([^\s@,.!?;:()[\]{}"'`]+)/.exec(text);
  if (mid) return { handle: mid[2]!.toLowerCase(), leading: false };
  return null;
}

/**
 * Removes a leading `@<handle>` mention from the text, trimming the
 * remainder. Only a mention that started the message is consumed.
 */
export function consumeLeadingMention(text: string, handle: string): string {
  const pattern = /^\s*@[^\s@]+\s*/;
  const rest = text.replace(pattern, "");
  return rest.trimStart();
}

/**
 * Resolves the `@<alias>` addressee of a bridged chat message among the
 * company's agents. One read-only select; no vendor files involved.
 */
export async function resolveTelegramAddressee(
  db: DbOrTx,
  companyId: string,
  text: string,
  _endpointAgentId: string | null,
): Promise<ResolveResult> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      title: agents.title,
      metadata: agents.metadata,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const candidates: CandidateRow[] = [];
  for (const row of rows) {
    const aliases = [
      ...readTelegramAliases(row.metadata),
      ...readTelegramAliases(row.adapterConfig),
    ];
    const aliasSet = new Set(aliases);
    candidates.push({
      agentId: row.id,
      displayName: row.name,
      handle: row.name.trim().toLowerCase(),
      kind: "name",
    });
    for (const alias of aliasSet) {
      candidates.push({
        agentId: row.id,
        displayName: row.name,
        handle: alias,
        kind: "alias",
      });
    }
    if (row.title) {
      const title = row.title.trim().toLowerCase();
      if (title) {
        candidates.push({
          agentId: row.id,
          displayName: row.name,
          handle: title,
          kind: "title",
        });
      }
    }
  }

  const empty: ResolveResult = {
    addressee: null,
    candidates: candidates.map((c) => c.handle).sort(),
    consumedText: null,
  };
  const mention = findMention(text);
  if (!mention) {
    return { ...empty, candidates: [] };
  }

  const matches = candidates
    .filter((c) => c.handle === mention.handle)
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.agentId.localeCompare(b.agentId),
    );
  const best = matches[0];
  if (!best) return empty;

  return {
    addressee: { agentId: best.agentId, displayName: best.displayName },
    candidates: empty.candidates,
    consumedText: mention.leading
      ? consumeLeadingMention(text, mention.handle)
      : null,
  };
}

// ---- myrmidon(X9b): bridge routing helpers (alias lookup used by bridge.ts) ----
// Kept beside the X9a core under distinct names: `resolveBridgeAddressee`
// (X9b, longest-prefix lookup for routing) vs `resolveTelegramAddressee` (X9a).

/** The card's `telegramAliases` list; absent or non-array means empty. */
function readCardTelegramAliases(card: Record<string, unknown> | null | undefined): string[] {
  const raw = card?.telegramAliases;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * `@<alias>` tokens the resolver looks for. A token is `@` followed by word
 * characters (letters, digits, underscore). The longest match wins so a
 * `@гип` token cannot shadow `@гип2`.
 */
const MENTION_PATTERN = /@([\p{L}\p{N}_]+)/gu;

/**
 * myrmidon(X9b): removes the leading @-token (with surrounding whitespace)
 * from an addressed turn's text. The addressee is already routed by the
 * caller, so the alias token itself is noise in the standing conversation.
 * Only the FIRST token is removed, and only at the start (after optional
 * leading whitespace); an @-mention mid-text is ordinary content and stays.
 */
export function stripLeadingMentionToken(text: string): string {
  return text.replace(/^\s*@([\p{L}\p{N}_]+)\s*/u, "");
}

/** Extracts every @-token in the text, in order of appearance. */
export function extractMentionTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const token = match[1] ?? "";
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

interface AgentCandidate {
  id: string;
  name: string;
  title: string | null;
  aliases: string[];
}

async function loadCompanyAgents(db: Db, companyId: string): Promise<AgentCandidate[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      title: agents.title,
      adapterConfig: agents.adapterConfig,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    aliases: [
      ...readCardTelegramAliases(row.adapterConfig as Record<string, unknown> | null),
      ...readCardTelegramAliases(row.metadata as Record<string, unknown> | null),
    ],
  }));
}

/**
 * Resolves the first @-token in `text` that matches an agent of `companyId`.
 * Alias match first, then agent name, then title, case-insensitive; the
 * longest alias of a candidate wins. Returns null when no token resolves.
 */
export async function resolveBridgeAddressee(
  db: Db,
  input: {
    companyId: string;
    text: string;
    /** The endpoint's assigned agent: also addressable by name/alias/title. */
    endpointAgentId: string;
  },
): Promise<TelegramAddressee | null> {
  const tokens = extractMentionTokens(input.text);
  if (tokens.length === 0) return null;
  const candidates = await loadCompanyAgents(db, input.companyId);
  const byToken = new Map<string, string>();
  for (const candidate of candidates) {
    for (const alias of candidate.aliases) {
      const key = normalizeAlias(alias);
      if (!key) continue;
      if (!byToken.has(key)) byToken.set(key, candidate.id);
    }
    for (const field of [candidate.name, candidate.title]) {
      if (!field) continue;
      const key = normalizeAlias(field);
      if (!key) continue;
      if (!byToken.has(key)) byToken.set(key, candidate.id);
    }
  }
  for (const token of tokens) {
    // Longest-match-first: try the whole token, then progressively shorter
    // prefixes, so `@гип2` does not resolve as `@гип` plus a stray `2`.
    for (let length = token.length; length > 0; length -= 1) {
      const agentId = byToken.get(token.slice(0, length).toLowerCase());
      if (agentId) {
        const agent = candidates.find((candidate) => candidate.id === agentId)!;
        return { agentId, displayName: agent.name };
      }
    }
  }
  return null;
}

/**
 * The polite list shown when an @-token does not resolve: aliases first (the
 * operator's chosen short names), falling back to names.
 */
export function describeAddressableAgents(
  candidates: Array<{ name: string; aliases: string[] }>,
): string {
  const parts = candidates.map((candidate) => {
    const alias = candidate.aliases[0];
    return alias ? `@${alias}` : `@${candidate.name}`;
  });
  return parts.join(", ");
}