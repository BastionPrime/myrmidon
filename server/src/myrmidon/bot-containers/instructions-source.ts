// server/src/myrmidon/bot-containers/instructions-source.ts
//
// myrmidon(W2a): what a container bot is told, and who owns telling it.
//
// One owner. The bot's instructions reach the model exactly once, as the
// workspace/AGENTS.md this wiring writes into the container. The gateway
// adapter (G4) must NOT add them a second time to the /v1/runs `instructions`
// field for a card in container mode (`container.enabled === true`): the model
// would read the same text twice, per run, at the price of the prompt. The
// contract for the adapter is in DIVERGENCE.md.
//
// So AGENTS.md carries everything the adapter would have sent for a card that
// is not in a container: the Paperclip-managed bundle's entry file, then the
// card's own stable instructions, joined the way the adapter joins them (the
// same "\n\n---\n\n" separator, the same default line when the card has none).
// The bundle's other files (HEARTBEAT.md, SOUL.md, a docs/ folder) go beside it
// under /workspace with their relative paths, because the entry file refers to
// them and the agent resolves those references against its working directory.
//
// The functions here are pure over injected file access; profile-ports.ts binds
// them to the board's instructions service.

import type { HermesProfileWorkspaceFile } from "./profile-compiler.js";

/** The separator between the bundle and the card's own instructions (the adapter's layering). */
export const INSTRUCTIONS_SEPARATOR = "\n\n---\n\n";

/**
 * What the adapter falls back to when a card carries no instructions of its own.
 * Kept identical to the adapter's line so a bot behaves the same in or out of a container.
 */
export const DEFAULT_CARD_INSTRUCTIONS =
  "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";

/** Bundle limits: a bundle is a handful of markdown files, not a file store. */
export const BUNDLE_MAX_FILES = 50;
export const BUNDLE_MAX_FILE_BYTES = 256 * 1024;
export const BUNDLE_MAX_PATH_LENGTH = 200;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The card's own stable instructions, resolved the way the adapter resolves them:
 * `adapterConfig.instructions`, else `adapterConfig.payloadTemplate.instructions`,
 * else the default line. Always non-empty.
 */
export function resolveCardInstructions(adapterConfig: Record<string, unknown>): string {
  return (
    nonEmpty(adapterConfig.instructions) ??
    nonEmpty(asRecord(adapterConfig.payloadTemplate).instructions) ??
    DEFAULT_CARD_INSTRUCTIONS
  );
}

/** The full text of workspace/AGENTS.md: the bundle's entry file (if any), then the card's instructions. */
export function composeAgentsMd(bundleEntryText: string, cardInstructions: string): string {
  const entry = bundleEntryText.trim();
  return entry ? `${entry}${INSTRUCTIONS_SEPARATOR}${cardInstructions}` : cardInstructions;
}

export interface BotInstructionsBundleListing {
  entryFile: string;
  files: ReadonlyArray<{
    path: string;
    size: number;
    /** A file that exists only in the listing (the board's legacy prompt template), not on disk. */
    virtual?: boolean;
  }>;
}

export interface BotInstructionsBundleSource {
  /** The agent's bundle; null when the agent has none. */
  listBundle(): Promise<BotInstructionsBundleListing | null>;
  /** One file's text. Rejects when it cannot be read: a bundle that half-loads must not look complete. */
  readFile(relativePath: string): Promise<string>;
}

export interface LoadedBotInstructions {
  /** The entry file's text; "" when the agent has no bundle or its entry file is missing or blank. */
  entryText: string;
  /** Every other text file of the bundle, sorted by path. */
  files: HermesProfileWorkspaceFile[];
  warnings: string[];
}

/**
 * Reads a bundle for a container bot. Oversized, binary and over-count files are
 * skipped with a warning (never truncated: half a file is worse than none). A
 * file that fails to read is an error, not a warning: with the file gone the
 * profile's hash would change and a working bot would lose its instructions.
 */
export async function loadBotInstructionsBundle(source: BotInstructionsBundleSource): Promise<LoadedBotInstructions> {
  const warnings: string[] = [];
  const listing = await source.listBundle();
  if (!listing) return { entryText: "", files: [], warnings };

  const real = listing.files.filter((file) => !file.virtual);
  const entry = real.find((file) => file.path === listing.entryFile);
  let entryText = "";
  if (entry) {
    if (entry.size > BUNDLE_MAX_FILE_BYTES) {
      warnings.push(`instructions bundle: entry file ${entry.path} is larger than ${BUNDLE_MAX_FILE_BYTES} bytes, skipped`);
    } else {
      entryText = await source.readFile(entry.path);
    }
  }

  const siblings = real
    .filter((file) => file.path !== listing.entryFile)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files: HermesProfileWorkspaceFile[] = [];
  for (const sibling of siblings) {
    if (files.length >= BUNDLE_MAX_FILES) {
      warnings.push(`instructions bundle: more than ${BUNDLE_MAX_FILES} files, ${sibling.path} and the rest skipped`);
      break;
    }
    if (sibling.path.length > BUNDLE_MAX_PATH_LENGTH) {
      warnings.push(`instructions bundle: path of ${sibling.path.slice(0, 40)}... is longer than ${BUNDLE_MAX_PATH_LENGTH} characters, skipped`);
      continue;
    }
    if (sibling.size > BUNDLE_MAX_FILE_BYTES) {
      warnings.push(`instructions bundle: ${sibling.path} is larger than ${BUNDLE_MAX_FILE_BYTES} bytes, skipped`);
      continue;
    }
    const content = await source.readFile(sibling.path);
    if (content.includes("\u0000")) {
      warnings.push(`instructions bundle: ${sibling.path} is binary, skipped`);
      continue;
    }
    files.push({ path: sibling.path, content });
  }
  return { entryText, files, warnings };
}
