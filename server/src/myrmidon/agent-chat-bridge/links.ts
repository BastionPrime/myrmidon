/**
 * myrmidon(X8g): board task/project links in an agent's own reply text are
 * written as board-relative paths (`/issues/<id>`, `[label](/projects/<id>)`).
 * Telegram has no notion of the board's origin, so a relative markdown link
 * loses its href entirely once the outgoing-chat sanitizer rejects it as an
 * unparsable URL, and a bare relative path is just inert text. Turning board
 * links absolute before that sanitizer runs lets them survive as real,
 * clickable links — but only for publications bound for Telegram; every
 * other provider, and the board comment itself, keep the original text.
 */

import { and, eq, inArray } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import { sanitizeExternalChatUrl } from "../../services/chat-publication-projection.js";

/** Board routes a relative link or bare path may point at (`ui/src/App.tsx`). */
const BOARD_PATH_PREFIX = /^\/(?:issues|projects)\//;

const MARKDOWN_LINK_RE = /\[([^\]\r\n]{1,500})\]\(([^)\r\n]+)\)/g;
const CODE_SEGMENT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`)/g;
// A bare path must start a line or follow whitespace/`(`, so it is never torn
// out of a longer URL or word; trailing sentence punctuation stays outside it.
const BARE_BOARD_PATH_RE =
  /(^|[\s(])(\/(?:issues|projects)\/[^\s)\]<>"'`]+)/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

/**
 * Combines a board-relative path with the board's own public origin, reusing
 * the outgoing-chat URL sanitizer so an absolutized link is held to the same
 * safety rules (public https origin only) as every other link Paperclip
 * sends to a provider. Returns null for anything that does not clear it,
 * leaving the caller to keep the original text unchanged.
 */
function absoluteBoardUrl(
  path: string,
  publicBaseUrl: string,
  sanitize: (url: string) => string | null,
): string | null {
  try {
    const absolute = new URL(path, publicBaseUrl).toString();
    return sanitize(absolute);
  } catch {
    return null;
  }
}

/**
 * Rewrites board-relative task/project links in `text` to absolute URLs
 * against `publicBaseUrl`. Markdown links (`[label](/issues/x)`) and bare
 * paths (`/issues/x` in running prose) are both rewritten; links already
 * absolute, external links, and anything inside a fenced or inline code span
 * are left untouched. Without a usable `publicBaseUrl` the text is returned
 * unchanged.
 *
 * `sanitize` defaults to the board's own outgoing-chat URL sanitizer
 * (`sanitizeExternalChatUrl`); tests may substitute a permissive stand-in so
 * the pure link-rewriting behavior can be checked without its http-origin
 * restriction (e.g. against an `http://` fixture base URL).
 */
export function absolutizeBoardLinks(
  text: string,
  publicBaseUrl: string | null | undefined,
  sanitize: (url: string) => string | null = sanitizeExternalChatUrl,
): string {
  const base = publicBaseUrl?.trim();
  if (!text || !base) return text;

  const rewriteSegment = (segment: string): string => {
    let out = segment.replace(
      MARKDOWN_LINK_RE,
      (match, label: string, href: string) => {
        const trimmedHref = href.trim();
        if (!BOARD_PATH_PREFIX.test(trimmedHref)) return match;
        const absolute = absoluteBoardUrl(trimmedHref, base, sanitize);
        return absolute ? `[${label}](${absolute})` : match;
      },
    );
    out = out.replace(
      BARE_BOARD_PATH_RE,
      (match, lead: string, rawPath: string) => {
        const trailing = rawPath.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
        const path = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
        if (!path) return match;
        const absolute = absoluteBoardUrl(path, base, sanitize);
        return absolute ? `${lead}${absolute}${trailing}` : match;
      },
    );
    return out;
  };

  // Split on fenced/inline code so link rewriting never reaches inside one;
  // a capturing split places matched code segments at odd indices.
  return text
    .split(CODE_SEGMENT_RE)
    .map((part, index) => (index % 2 === 1 ? part : rewriteSegment(part)))
    .join("");
}

/**
 * The board's own public origin, read directly from the environment because
 * `issueService(db)` (dozens of call sites, see CONVENTIONS.md §12) takes no
 * options to thread server config through. Mirrors the env-only part of
 * `server/src/config.ts`'s `authPublicBaseUrl` resolution (its config-file
 * and managed-runtime-URL fallbacks are out of reach here; an operator using
 * only those sees Telegram links stay relative, same as today).
 */
export function resolveBoardPublicBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw =
    env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ||
    env.BETTER_AUTH_URL ||
    env.BETTER_AUTH_BASE_URL ||
    env.PAPERCLIP_PUBLIC_URL ||
    null;
  const trimmed = raw?.trim();
  return trimmed || null;
}

/** The subset of `endpointIds` whose `chatEndpoints.provider` is `telegram`. */
export async function telegramEndpointIds(
  dbOrTx: Db,
  companyId: string,
  endpointIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(endpointIds)];
  if (!unique.length) return new Set();
  const rows = await dbOrTx
    .select({ id: chatEndpoints.id })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.provider, "telegram"),
        inArray(chatEndpoints.id, unique),
      ),
    );
  return new Set(rows.map((row: { id: string }) => row.id));
}

/**
 * Board-link-absolutized `text` for each of `endpointIds` that is a Telegram
 * endpoint; endpoints of every other provider are left out of the returned
 * map, so a missing entry means "publish `text` unchanged".
 */
export async function absolutizedTextByTelegramEndpoint(
  dbOrTx: Db,
  companyId: string,
  endpointIds: readonly string[],
  text: string,
): Promise<ReadonlyMap<string, string>> {
  const telegramIds = await telegramEndpointIds(dbOrTx, companyId, endpointIds);
  if (!telegramIds.size) return new Map();
  const publicBaseUrl = resolveBoardPublicBaseUrl();
  const absolutized = absolutizeBoardLinks(text, publicBaseUrl);
  return new Map([...telegramIds].map((id) => [id, absolutized]));
}
