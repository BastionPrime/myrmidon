// server/src/myrmidon/bot-containers/instructions-source.ts
//
// myrmidon(W2a): the files of a container bot's instructions bundle.
//
// The bot's instructions reach the model through the gateway adapter (G4): its
// `/v1/runs` request carries the bundle's entry file and the card's own stable
// instructions in the `instructions` field, the same in or out of a container.
// This wiring deliberately does NOT write them into workspace/AGENTS.md. The
// vendor gateway injection-scans every project context file it loads and
// replaces a whole file that matches a pattern (a `curl ... $API_KEY` example is
// enough) with a "[BLOCKED ... Content not loaded.]" stub, and the bot would run
// without any instructions at all; the run request's `instructions` field is
// not scanned.
//
// What does go into the container is the rest of the bundle (HEARTBEAT.md,
// SOUL.md, a docs/ folder), under /workspace with the relative paths the
// instructions use: the agent resolves those references against its working
// directory. The entry file itself is not read here.
//
// The functions here are pure over injected file access; profile-ports.ts binds
// them to the board's instructions service.

import type { HermesProfileWorkspaceFile } from "./profile-compiler.js";

/** Bundle limits: a bundle is a handful of markdown files, not a file store. */
export const BUNDLE_MAX_FILES = 50;
export const BUNDLE_MAX_FILE_BYTES = 256 * 1024;
export const BUNDLE_MAX_PATH_LENGTH = 200;

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
  /** Every text file of the bundle except its entry file, sorted by path; [] when the agent has no bundle. */
  files: HermesProfileWorkspaceFile[];
  warnings: string[];
}

/**
 * Reads a bundle's files for a container bot. Oversized, binary and over-count files are
 * skipped with a warning (never truncated: half a file is worse than none). A
 * file that fails to read is an error, not a warning: with the file gone the
 * profile's hash would change and a working bot would lose its instructions.
 */
export async function loadBotInstructionsBundle(source: BotInstructionsBundleSource): Promise<LoadedBotInstructions> {
  const warnings: string[] = [];
  const listing = await source.listBundle();
  if (!listing) return { files: [], warnings };

  const real = listing.files.filter((file) => !file.virtual);
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
  return { files, warnings };
}
