// myrmidon(X9b): @<alias> addressing in a bridged Telegram chat routes the
// message to any agent of the same company, not only the endpoint's assigned
// agent. This module resolves the alias: exact match on a configured alias
// first, then the agent name, then the agent title. It is pure lookup logic —
// the routing decisions live in bridge.ts and the call sites in
// chat-channels.ts (see docs/myrmidon/DIVERGENCE.md, X9b).
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";

/** A resolved @<alias> addressee. `displayName` is what the reply prefix uses. */
export interface TelegramAddressee {
  agentId: string;
  displayName: string;
}

/** The card's `telegramAliases` list; absent or non-array means empty. */
function readTelegramAliases(card: Record<string, unknown> | null | undefined): string[] {
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
      ...readTelegramAliases(row.adapterConfig as Record<string, unknown> | null),
      ...readTelegramAliases(row.metadata as Record<string, unknown> | null),
    ],
  }));
}

/**
 * Resolves the first @-token in `text` that matches an agent of `companyId`.
 * Alias match first, then agent name, then title, case-insensitive; the
 * longest alias of a candidate wins. Returns null when no token resolves.
 */
export async function resolveTelegramAddressee(
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
